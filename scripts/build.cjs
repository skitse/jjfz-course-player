const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;
const bank = JSON.parse(read('data/questions.json'));
const video = read('src/course-player.js').replace(/^\/\/ @version[^\n]*/m, '// @version      ' + version);
const moduleSource = file => read(file).replace(/^if \(typeof module[^\n]*\n?/gm, '');
const assistant = '\n(() => {\n  "use strict";\n' + moduleSource('src/question-core.js') + '\n'
  + moduleSource('src/question-assistant.js') + '\nrunQuestionAssistant(' + JSON.stringify(bank.questions) + ');\n})();\n';
const output = video + assistant;
const target = path.join(root, 'jjfz-course-player.user.js');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw Error('Generated userscript is stale; run npm run build');
} else fs.writeFileSync(target, output);
console.log(JSON.stringify({ version, questions: bank.questions.length, bytes: Buffer.byteLength(output), checked: process.argv.includes('--check') }));
