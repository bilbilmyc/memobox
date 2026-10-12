/** 发布已通过全部门禁的五个平台资产；重跑核对已有字节，禁止覆盖。 */
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
assert.equal(process.env.GITHUB_REPOSITORY,'bilbilmyc/memobox');assert.equal(process.env.GITHUB_REF,'refs/heads/main');assert.equal(process.env.GITHUB_EVENT_NAME,'push');
const pkg=JSON.parse(readFileSync('package.json','utf8'));assert(/^\d+\.\d+\.\d+$/.test(pkg.version));
const receipt=JSON.parse(readFileSync('release/receipt.json','utf8'));assert.equal(receipt.revision,process.env.GITHUB_SHA);assert.equal(receipt.version,pkg.version);assert.equal(receipt.cliAndMcpPassed,true);
const platforms=['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'];assert.deepEqual([...receipt.platforms].sort(),platforms);
const tag='v'+pkg.version,repo='bilbilmyc/memobox';
function gh(args,missing=false){const result=spawnSync('gh',[...args,'--repo',repo],{encoding:'utf8',windowsHide:true,timeout:180000});if(result.status!==0){if(missing&&result.stderr.includes('404'))return null;throw Error('GitHub release command failed: '+result.stderr);}return result.stdout;}
// gh api 使用 REST 路径确定仓库，无 --repo 选项。
function api(path,missing=false){const result=spawnSync('gh',['api','repos/'+repo+'/'+path],{encoding:'utf8',timeout:30000});if(result.status!==0){if(missing&&result.stderr.includes('404'))return null;throw Error('GitHub metadata lookup failed: '+result.stderr);}return JSON.parse(result.stdout);}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const tarball=resolve('release',receipt.filename);assert.equal('sha512-'+createHash('sha512').update(readFileSync(tarball)).digest('base64'),receipt.integrity);
const unpack=spawnSync('tar',['-xOf',tarball,'package/bin/manifest.json'],{encoding:'utf8'});assert.equal(unpack.status,0);const manifest=JSON.parse(unpack.stdout);assert.equal(manifest.version,pkg.version);assert.deepEqual(Object.keys(manifest.platforms).sort(),platforms);
const assets=[],sums=[];
for(const platform of platforms){
 const native=JSON.parse(readFileSync(join('artifacts',platform,'receipt.json'),'utf8')),entry=manifest.platforms[platform];
 assert.equal(native.revision,process.env.GITHUB_SHA);assert.equal(native.nativePassed,true);assert.equal(native.tests.realLocalModelPassed,true);assert.equal(native.tests.endpointPassed,true);assert.equal(native.tests.piExtensionPassed,true);
 assert.equal(entry.asset,`memobox-${pkg.version}-${platform}.gz`);assert.equal(native.asset,entry.asset);assert.equal(native.sha256,entry.sha256);assert.equal(native.compressedSha256,entry.compressedSha256);
 const path=resolve('artifacts',platform,entry.asset);assert.equal(hash(path),entry.compressedSha256);assets.push({path,name:entry.asset,hash:entry.compressedSha256});sums.push(entry.compressedSha256+'  '+entry.asset);
}
writeFileSync('release/SHA256SUMS',sums.join('\n')+'\n');writeFileSync('release/manifest.json',JSON.stringify(manifest,null,2)+'\n');
for(const name of ['SHA256SUMS','manifest.json'])assets.push({path:resolve('release',name),name,hash:hash('release/'+name)});
let release=api('releases/tags/'+tag,true);
const existingCommit=api('commits/'+tag,true);if(existingCommit)assert.equal(existingCommit.sha,process.env.GITHUB_SHA,'Existing release tag targets another commit');
if(!release){gh(['release','create',tag,'--target',process.env.GITHUB_SHA,'--draft','--title','memobox '+pkg.version,'--notes-file','docs/RELEASE-2.6.3.md']);release=api('releases/tags/'+tag);}
if(release.draft)assert.equal(release.target_commitish,process.env.GITHUB_SHA,'Draft release targets another commit');
if(!release.draft)assert.equal(api('commits/'+tag).sha,process.env.GITHUB_SHA);
const verify=resolve('artifacts/release-verification');mkdirSync(verify,{recursive:true});
for(const asset of assets){
 const present=release.assets.find(item=>item.name===asset.name);
 if(!present){assert(release.draft,'Cannot add assets to an already published release');gh(['release','upload',tag,asset.path]);}
 const destination=join(verify,asset.name);
 if(!existsSync(destination))gh(['release','download',tag,'--pattern',asset.name,'--dir',verify]);
 assert.equal(hash(destination),asset.hash,'Uploaded asset differs from the tested artifact: '+asset.name);
}
if(release.draft)gh(['release','edit',tag,'--draft=false','--latest']);
console.log('Verified native release assets: https://github.com/'+repo+'/releases/tag/'+tag);
