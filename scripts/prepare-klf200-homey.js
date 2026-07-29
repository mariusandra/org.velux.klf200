'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const dependencyDir = path.join(rootDir, 'node_modules', 'klf-200-api');
const packageJsonPath = path.join(dependencyDir, 'package.json');

function main() {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error('Missing node_modules/klf-200-api/package.json');
  }

  const dependencyPackageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (dependencyPackageJson.name !== 'klf-200-api') {
    throw new Error('Unexpected package in node_modules/klf-200-api');
  }

  const cjsIndexPath = path.join(dependencyDir, 'dist', 'cjs', 'index.js');
  const typesIndexPath = path.join(dependencyDir, 'dist', 'types', 'index.d.ts');
  const cjsPackageJsonPath = path.join(dependencyDir, 'dist', 'cjs', 'package.json');

  if (fs.existsSync(cjsIndexPath) && fs.existsSync(typesIndexPath)) {
    if (!fs.existsSync(cjsPackageJsonPath)) {
      fs.writeFileSync(cjsPackageJsonPath, '{\n  "type": "commonjs"\n}\n');
    }
    return;
  }

  for (const [command, args, errorMessage] of [
    ['npm', ['install', '--include=dev', '--no-audit', '--no-fund'], 'Failed installing klf-200-api build dependencies'],
    ['npm', ['run', 'build'], 'Failed building klf-200-api'],
  ]) {
    const result = cp.spawnSync(command, args, { cwd: dependencyDir, stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      throw new Error(errorMessage);
    }
  }

  if (!fs.existsSync(cjsPackageJsonPath)) {
    fs.writeFileSync(cjsPackageJsonPath, '{\n  "type": "commonjs"\n}\n');
  }
}

main();
