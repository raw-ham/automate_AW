import path from 'node:path';import {fileURLToPath} from 'node:url';import {config} from 'dotenv';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');config({path:path.join(root,'.env')});
export default (phase)=>({distDir:phase==='phase-development-server'?'.next-dev':'.next',transpilePackages:['@allo/core'],outputFileTracingRoot:root});
