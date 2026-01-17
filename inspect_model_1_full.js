
const fs = require('fs');
const path = './models/index.json';
const models = JSON.parse(fs.readFileSync(path, 'utf8'));
console.log(JSON.stringify(models["1"].group.points.map(p => p.name), null, 2));
