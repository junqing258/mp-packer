const fs = require("fs-extra");
const path = require("path");
const { parse } = require("@babel/parser");
const { default: traverse } = require("@babel/traverse");
const htmlparser2 = require("htmlparser2");
const { root } = require("./config");

const Extends = [".js", ".wxs", ".json", ".wxml", ".wxss"];

class Depend {
  constructor() {
    this.tree = {};
    this.files = new Set();
    this.context = path.join(root, "");
  }
  // 获取绝对地址
  getAbsolute(file) {
    if (String(file).startsWith(this.context)) return file;
    return path.join(this.context, file);
  }
  // 修改文件后缀
  replaceExt(filePath, ext = "") {
    const dirName = path.dirname(filePath);
    const extName = path.extname(filePath);
    const fileName = path.basename(filePath, extName);
    return path.join(dirName, fileName + ext);
  }

  createTree(pkg) {
    this.tree[pkg] = {
      size: 0,
      children: {},
    };
  }

  addPage(page, pkg) {
    const absPath = this.getAbsolute(page);
    Extends.forEach((ext) => {
      const filePath = this.replaceExt(absPath, ext);
      if (fs.existsSync(filePath)) {
        this.addToTree(filePath, pkg);
      }
    });
  }

  run() {
    const appPath = this.getAbsolute("app_2.json");
    const appJson = fs.readJsonSync(appPath);
    const { pages, subPackages, subpackages } = appJson;

    this.createTree("main"); // 为主包创建文件树
    pages.forEach((page) => {
      this.addPage(page, "main");
    });
    // 由于 app.json 中 subPackages、subpackages 都能生效
    // 所以我们两个属性都获取，哪个存在就用哪个
    let subPkgs = subPackages || subpackages;

    subPkgs = subPkgs.filter((v) => v.root === "page/usecar/");

    // 分包存在的时候才进行遍历
    if (subPkgs) {
      subPkgs.forEach(({ root, pages }) => {
        this.createTree(root); // 为分包创建文件树
        pages.forEach((page) => {
          this.addPage(`${root}${path.sep}${page}`, root);
        });
      });
    }
    // 输出文件树
    fs.writeJSONSync("./out/tree.json", this.tree, { spaces: 2 });

    const files = Array.from(this.files)
      .map((v) => path.relative(root, v))
      .sort();
    fs.writeJSONSync("./out/files.json", files, { spaces: 2 });
  }

  // 获取相对地址
  getRelative(file) {
    return path.relative(this.context, file);
  }
  // 获取文件大小，单位 KB
  getSize(file) {
    const stats = fs.statSync(file);
    return stats.size / 1024;
  }

  getDeps(file) {
    const ext = path.extname(file);
    if (ext === ".js") return this.jsDeps(file);
    if (ext === ".json") return this.jsonDeps(file);
    if (ext === ".wxml") return this.wxmlDeps(file);
    if (ext === ".wxss") return this.wxssDeps(file);
    return [];
  }

  // 将文件添加到树中
  addToTree(filePath, pkg = "main") {
    if (this.files.has(filePath)) {
      // 如果该文件已经添加过，则不再添加到文件树中
      return;
    }
    let relPath = this.getRelative(filePath);
    if (pkg !== "main" && relPath.indexOf(pkg) !== 0) {
      // 如果该文件不是以分包名开头，证明该文件不在分包内，
      // 需要将文件添加到主包的文件树内
      pkg = "main";
    }

    const tree = this.tree[pkg]; // 依据 pkg 取到对应的树
    const size = this.getSize(filePath);
    const names = relPath.split(path.sep);
    const lastIdx = names.length - 1;

    tree.size += size;
    let point = tree.children;
    names.forEach((name, idx) => {
      if (idx === lastIdx) {
        point[name] = { size };
        return;
      }
      if (!point[name]) {
        point[name] = {
          size,
          children: {},
        };
      } else {
        point[name].size += size;
      }
      point = point[name].children;
    });
    // 将文件添加的 files
    this.files.add(filePath);

    // ===== 获取文件依赖，并添加到树中 =====
    const deps = this.getDeps(filePath);
    deps.forEach((dep) => {
      this.addToTree(dep);
    });
  }

  jsDeps(file) {
    const deps = [];
    const dirName = path.dirname(file);
    // 读取 js 文件内容
    const content = fs.readFileSync(file, "utf-8");
    // 将代码转化为 AST
    const ast = parse(content, {
      sourceType: "module",
      plugins: ["exportDefaultFrom"],
    });
    // 遍历 AST
    traverse(ast, {
      ImportDeclaration: ({ node }) => {
        // 获取 import from 地址
        const { value } = node.source;
        const jsFile = this.transformScript(dirName, value);
        if (jsFile) {
          deps.push(jsFile);
        }
      },
      ExportNamedDeclaration: ({ node }) => {
        // 获取 export from 地址
        if (!node.source) {
          return;
        }
        const { value } = node.source;
        const jsFile = this.transformScript(dirName, value);
        if (jsFile) {
          deps.push(jsFile);
        }
      },
      CallExpression: ({ node }) => {
        if (
          node.callee.name &&
          node.callee.name === "require" &&
          node.arguments.length >= 1
        ) {
          // 获取 require 地址
          const [{ value }] = node.arguments;
          if (!value) return;

          const jsFile = this.transformScript(dirName, value);
          if (jsFile) {
            deps.push(jsFile);
          }
        }
      },
    });
    return deps;
  }

  // 获取某个路径的脚本文件
  transformScript(dir, val = "") {
    const url = path.join(dir, val);
    const ext = path.extname(url);
    // 如果存在后缀，表示当前已经是一个文件
    if ((ext === ".js" || ext === ".wxs") && fs.existsSync(url)) {
      return url;
    }
    // a/b/c => a/b/c.js
    const jsFile = url + ".js";
    if (fs.existsSync(jsFile)) return jsFile;

    const wxsFile = url + ".wxs";
    if (fs.existsSync(wxsFile)) return wxsFile;

    // a/b/c => a/b/c/index.js
    const jsIndexFile = path.join(url, "index.js");
    if (fs.existsSync(jsIndexFile)) {
      return jsIndexFile;
    }
    return null;
  }

  jsonDeps(file) {
    const deps = [];
    const dirName = path.dirname(file);
    const { usingComponents } = fs.readJsonSync(file);
    if (usingComponents && typeof usingComponents === "object") {
      Object.values(usingComponents).forEach((component) => {
        component = path.resolve(dirName, component);
        // 每个组件都需要判断 js/json/wxml/wxss 文件是否存在
        Extends.forEach((ext) => {
          let file = this.replaceExt(component, ext);
          file = this.getAbsolute(file);
          if (fs.existsSync(file)) {
            deps.push(file);
          }
        });
      });
    }
    return deps;
  }

  wxmlDeps(file) {
    const deps = [];
    const dirName = path.dirname(file);
    const content = fs.readFileSync(file, "utf-8");
    const htmlParser = new htmlparser2.Parser({
      onopentag(name, attribs = {}) {
        if (!["import", "require", "wxs"].includes(name)) return;
        const { src } = attribs;
        if (!src) return;
        const wxmlFile = path.resolve(dirName, src);
        if (fs.existsSync(wxmlFile)) {
          deps.push(wxmlFile);
        }
      },
    });
    htmlParser.write(content);
    htmlParser.end();
    return deps;
  }

  wxssDeps(file) {
    const deps = [];
    const dirName = path.dirname(file);
    const content = fs.readFileSync(file, "utf-8");
    const importRegExp = /@import\s*['"](.+)['"];*/g;
    let matched;
    while ((matched = importRegExp.exec(content)) !== null) {
      if (!matched[1]) {
        continue;
      }
      const wxssFile = path.resolve(dirName, matched[1]);
      if (fs.existsSync(wxssFile)) {
        deps.push(wxssFile);
      }
    }
    return deps;
  }
}

module.exports = new Depend();
