const fs = require("fs-extra");
const path = require("path");
const { root, riding_root } = require("./config");

const files = fs.readJsonSync(path.resolve(__dirname, '../out/files.json'))

files.forEach(file => {
  const from = path.join(root, file)
  const to = path.join(riding_root, file)
  fs.copySync(from, to)
})

console.log('复制完成！')