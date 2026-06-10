import test from "node:test";
import assert from "node:assert/strict";
import { classifyPythonCode } from "../dist/approval/RiskClassifier.js";

test("pure computation/read is safe", () => {
  assert.equal(classifyPythonCode("print(sum(range(10)))"), "safe");
  assert.equal(classifyPythonCode("data = open('a.txt').read(); print(len(data))"), "safe");
});

test("shelling out / deleting / writing needs approval", () => {
  assert.equal(classifyPythonCode("import subprocess; subprocess.run(['git','status'])"), "ask");
  assert.equal(classifyPythonCode("import os; os.remove('x.txt')"), "ask");
  assert.equal(classifyPythonCode("open('out.txt','w').write('hi')"), "ask");
  assert.equal(classifyPythonCode("import shutil; shutil.move('a','b')"), "ask");
});

test("networking is classified as network", () => {
  assert.equal(classifyPythonCode("import requests; requests.get('http://x')"), "network");
  assert.equal(classifyPythonCode("from urllib.request import urlopen"), "network");
});

test("package installs are global environment changes", () => {
  assert.equal(classifyPythonCode("import subprocess; subprocess.run('pip install requests')"), "global_environment_change");
});

test("recursive force deletes and sudo are denied", () => {
  assert.equal(classifyPythonCode("import os; os.system('rm -rf build')"), "deny");
  assert.equal(classifyPythonCode("import subprocess; subprocess.run('sudo apt-get update')"), "deny");
});
