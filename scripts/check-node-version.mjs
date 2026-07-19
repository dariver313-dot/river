const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const isSupported = (major === 22 && minor >= 13) || (major >= 23 && major < 25);

if (!isSupported) {
  throw new Error(`djmima 需要 Node.js 22.13 至 24；当前为 ${process.versions.node}。请先执行 nvm use 24。`);
}
