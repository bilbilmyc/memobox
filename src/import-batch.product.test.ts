import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteStore} from './db/sqlite-store';
test('批量导入 SQL 失败整批回滚；重复/并发编号保留首条，缓存只看到提交结果',async()=>{
const root=mkdtempSync(join(tmpdir(),'memobox-import-batch-')),path=join(root,'memory.db'),a=new SQLiteStore(null,path),b=new SQLiteStore(null,path),raw=new Database(path);
try{
await a.save({content:'现有记忆'});await b.search('batch_marker');
raw.exec("CREATE TRIGGER fail_import BEFORE INSERT ON memories WHEN NEW.id='fault' BEGIN SELECT RAISE(ABORT,'batch failure'); END");
let error;try{await a.importMemories([{id:'new',content:'batch_marker first',createdAt:1},{id:'fault',content:'batch_marker fault',createdAt:2}]);}catch(e){error=e;}
expect(error).toBeInstanceOf(Error);expect(await b.get('new')).toBeNull();expect((await b.search('batch_marker')).length).toBe(0);
raw.exec('DROP TRIGGER fail_import');
expect(await a.importMemories([{id:'new',content:'batch_marker first',createdAt:1},{id:'new',content:'overwritten',createdAt:2}])).toEqual({imported:1,skipped:1});
expect((await b.search('batch_marker'))[0].content).toBe('batch_marker first');
}finally{raw.close(true);a.close();b.close();if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('memobox-import-batch-'))throw Error('cleanup escape');rmSync(root,{recursive:true,force:true});}
});

