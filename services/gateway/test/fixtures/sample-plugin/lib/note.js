const fs = require('fs');
const path = require('path');

exports.readNote = () => fs.readFileSync(path.join(__dirname, '..', 'note.txt'), 'utf8').trim();
