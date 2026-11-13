import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./bridge.js',import.meta.url),'utf8');
test('every stream and read owns a separate lease; cleanup is memoized',()=>{
 assert.match(source,/const release=await channel.acquire\(signal\)/);
 assert.match(source,/async function read\(operation,signal\)/);
 assert.match(source,/if\(cleanupPromise\)return cleanupPromise/);
 assert.match(source,/if\(disposed\|\|!startPromise\|\|remoteStopped\)release\(\);else quarantined.add\(release\)/);
 assert.match(source,/finally\{await cleanup\(\);\}/);
});
test('watchdog only runs during yield suspension, never frees a lease by wall-clock age',()=>{
 assert.match(source,/armAbandoned\(\);try\{yield item;\}finally\{disarm\(\);\}/);
 assert.match(source,/if\(cleaned\)throw/);
 assert.match(source,/await boundedCleanup\(cancelRemote,3200\)/);
 assert.match(source,/channel.dispose\(\)/);
});
