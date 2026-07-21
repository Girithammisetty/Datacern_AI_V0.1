import fs from 'node:fs';import {JSDOM} from 'jsdom';
const html=fs.readFileSync(process.env.HOME+'/Projects/practice/Windrose_AI_UI_V0.1/index.html','utf8');
const d=new JSDOM(html,{runScripts:'dangerously',pretendToBeVisual:true}).window.document;
console.log('title      :', d.title);
console.log('brand      :', d.querySelector('.brand')?.textContent.trim());
console.log('footer     :', d.querySelector('footer')?.textContent.replace(/\s+/g,' ').trim().slice(0,60));
console.log('sections   : cards',d.querySelectorAll('#industry-cards .card').length,'faq',d.querySelectorAll('#acc .qa').length,'tabs',d.querySelectorAll('#tablist .tab').length);
console.log('no Windrose:', !/Windrose/.test(d.body.textContent));
console.log('reveal shown:', d.querySelectorAll('.reveal.in').length+'/'+d.querySelectorAll('.reveal').length);
