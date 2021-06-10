#! /usr/bin/env node
const {renameSync, readdirSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} = require('fs');
const jsonfile = require('jsonfile');
const convert = require('xml-js');
const { Observable, forkJoin } = require('rxjs');
const cp = require('child_process'),
exec = cp.exec;


const task = process.env.npm_config_task || 'rename_maximo_assets';

let build = {
  rename_maximo_assets: () => {
    return new Observable((observer) => {
      const path = process.env.npm_config_path;
      let count = 0;
      if(!path) {
        build.exit('path is required, provide --path=...');
      }
      let json = jsonfile.readFileSync(`${path}/prop.json`);
      if (json) {
        let fileInfo = JSON.parse(json['file_prop_info']);
        fileInfo.map((info) => {
          // console.log(info['original_file_name']);
          let type = /\.[0-9a-z]{1,5}$/i.exec(info.original_file_name)[0];
          let name = info.original_file_name.replace(type, '');
          // console.log(`${path}/${info._id}${type}`, `${path}/${info.original_file_name}`)
          // console.log(`${path}/${info._id}.xml`, `${path}/${name}.xml`)
          if(existsSync(`${path}/${info._id}.xml`) && existsSync(`${path}/${info._id}${type}`)) {
            renameSync(
              `${path}/${info._id}${type}`, 
              `${path}/${info.original_file_name}`);
            renameSync(
              `${path}/${info._id}.xml`, 
              `${path}/${name}.xml`);
            count++;
          }    
        })
        console.log(`renamed total of ${count} image files and ${count} xml files`)
        observer.next();
        observer.complete();
      } else {
        build.exit(json);
      }
    });
  },
  partition_dataset: () => {
    return new Observable((observer) => {
      const path = process.env.npm_config_path;
    if(!path) {
      build.exit('path is required, provide --path=...');
    }
    const train_ratio = process.env.npm_config_ratio || 0.9;
    let files = readdirSync(path);
      const assets = files.filter((file) => file.match(/jpg|png|gif|jpeg/i));
      const train_num = parseInt(assets.length * train_ratio);
      if(!existsSync(`${path}/train`)) {
        mkdirSync(`${path}/train`)
      } else {
        build.exit('train directory already exists');
      }
      if(!existsSync(`${path}/test`)) {
        mkdirSync(`${path}/test`)
      } else {
        build.exit('test directory already exists');
      }
      assets.forEach((asset, i) => {
        // console.log(asset, i)
        let type = /\.[0-9a-z]{1,5}$/i.exec(asset)[0];
        let name = asset.replace(type, '');
        let target = i < train_num ? 'train' : 'test';
        if(existsSync(`${path}/${name}.xml`) && existsSync(`${path}/${asset}`)) {
          copyFileSync(`${path}/${asset}`, `${path}/${target}/${asset}`);
          copyFileSync(`${path}/${name}.xml`, `${path}/${target}/${name}.xml`);
        }
      })
      console.log(`total: ${assets.length}, train: ${train_num}, test: ${assets.length-train_num}`);
      observer.next();
      observer.complete();
    });  
  },
  xml_to_csv: () => {
    return new Observable((observer) => {
        const path = process.env.npm_config_path;
      const origin = process.env.npm_config_origin;
      let xmls, csv = '';
      let $call = [];
      if(!path || !origin) {
        build.exit('path and orgin are required, provide --path=... --origin=...');
      }
      ['train', 'test'].forEach((target) => {
        const dir = `${path}/${target}`;
        console.log(target, origin)
        let files = readdirSync(dir);
          xmls = files.filter((file) => file.indexOf('.xml') > 0);
          // console.log(xmls)
          if(origin.toLowerCase() === 'maximo') {
            $call.push(build.maximo(xmls, dir, path));
          }
      })
      forkJoin($call)
      .subscribe((data) => {
        writeFileSync(`${path}/train/labels.csv`, data[0]);
        writeFileSync(`${path}/test/labels.csv`, data[1]);
        console.log('generating label.csv for train and test');
        observer.next();
        observer.complete();
        // console.log(data[0], data.length)
        // console.log(data[1], data.length)
      })
    });  
  },
  maximo: (xmls, dir, path) => {
    return new Observable((observer) => {
      let csv = 'filename,width,height,class,xmin,ymin,xmax,ymax\n';
      xmls.forEach(async(name, i) => {
        let xml = readFileSync(`${dir}/${name}`);
        let xmljson = JSON.parse(convert.xml2json(xml, {compact: true, space: 2}));
        // console.log(xmljson.annotation.object)
        let object = xmljson.annotation.object;
        let size = xmljson.annotation.size;  
        try {
          let json = jsonfile.readFileSync(`${path}/prop.json`);
            if (json) {
              let props = JSON.parse(json['file_prop_info']);
              if(!Array.isArray(object)) {
                object = [object];
              }
              object.forEach((obj) => {
                let prop = props.filter((f) => f._id === obj.file_id._text);
                if(prop.length != 1) {
                  build.exit(`file mismatched or duplicated: ${prop[0]._id}, ${prop[0].original_file_name}`);
                }
                let bbox = obj.bndbox;
                csv += `${prop[0].original_file_name},${size.width._text},${size.height._text},${obj.name._text},${bbox.xmin._text},${bbox.ymin._text},${bbox.xmax._text},${bbox.ymax._text}\n`;
              })
            } else {
              build.exit(json);
            }    
        } catch(e) {
          build.exit(`${name}: ${e}`)
        }
      })
      observer.next(csv);
      observer.complete();
    });
  },
  build_all: () => {
    return new Observable((observer) => {
      const origin = process.env.npm_config_origin;
      if(origin.toLowerCase() === 'maximo') {
        build.rename_maximo_assets()
        .subscribe(() => {
          build.partition_dataset()
          .subscribe(() => {
            build.xml_to_csv()
            .subscribe(() => {
              observer.next();
              observer.complete();
            })
          })
        })
      }
    });
  },
  generate_tfrecord: () => {
    return new Observable((observer) => {
      const csv_input = process.env.npm_config_csv_input;
      const image_dir = process.env.npm_config_image_dir;
      const output_path = process.env.npm_config_output_path;

      let arg = `python ${__dirname}/generate_tfrecord.py --csv_input=${csv_input} --image_dir=${image_dir} --output_path=${output_path}`;
      exec(arg, {maxBuffer: 1024 * 2000}, (err, stdout, stderr) => {
        if(!err) {
          console.log(stdout)
          console.log(`done generating ${output_path}`);
          observer.next();
          observer.complete();
        } else {
          console.log(`failed to generate ${output_path}`, err);
        }
      });
    });  
  },
  exit: (msg) => {
    console.log(msg);
    process.exit(0);
  }
}

build[task]()
.subscribe(() => console.log('process completed.'));