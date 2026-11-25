import test from 'node:test';
import assert from 'node:assert/strict';
import {coverageIndex,splitGroup,availableChoices,overlaps,overlapMessage,coveredCaption,hiddenCaption} from '../shared/backup-coverage.js';
// One container or static website folder belongs to one app: the wizard, the Map "+" and the API share these rules.
const sites=[
 {id:'media',name:'Gallery',serverId:'host',config:{kind:'docker',containers:['media-web','media-db']}},
 {id:'paper',name:'Paperless',serverId:'host',config:{kind:'docker',containers:['paper-redis']}},
 {id:'blog',name:'Blog',serverId:'host',config:{kind:'static',containers:[],documentRoot:'/var/www/blog'}},
 {id:'elsewhere',name:'Elsewhere',serverId:'other',config:{kind:'docker',containers:['paper-web']}},
];
const index=coverageIndex(sites,'host'),name=container=>container.name;

test('the index holds the containers and static folders of apps on that server only',()=>{
 assert.deepEqual([...index.containers.keys()],['media-web','media-db','paper-redis']);
 assert.deepEqual(index.containers.get('media-db'),{siteId:'media',name:'Gallery'});
 assert.deepEqual([...index.roots.keys()],['/var/www/blog']);
 assert.equal(index.containers.has('paper-web'),false);
});

test('an app being edited does not count against itself',()=>{
 const own=coverageIndex(sites,'host',{exceptSiteId:'media'});
 assert.equal(own.containers.has('media-web'),false);
 assert.equal(own.containers.has('paper-redis'),true);
 assert.deepEqual(overlaps({containers:['media-web','media-db']},own),{items:[],owners:[]});
});

test('a fully covered group is hidden, a partly covered one keeps its free services and names the owners',()=>{
 const choices=[{id:'compose:media',kind:'compose',containers:[{name:'media-web'},{name:'media-db'}]},{id:'compose:paper',kind:'compose',containers:[{name:'paper-web'},{name:'paper-redis'}]},{id:'static:blog',kind:'static',documentRoot:'/var/www/blog',containers:[]},{id:'static:shop',kind:'static',documentRoot:'/var/www/shop',containers:[]}];
 const {shown,hidden}=availableChoices(choices,index,name);
 assert.deepEqual(shown.map(choice=>choice.id),['compose:paper','static:shop']);
 assert.deepEqual(shown[0].containers,[{name:'paper-web'}]);
 assert.equal(coveredCaption(shown[0]),'1 more service already backed up in Paperless');
 assert.deepEqual(hidden.map(choice=>choice.id),['compose:media','static:blog']);
 assert.equal(hiddenCaption(hidden),'Hidden because other apps already back them up: Gallery, Blog.');
});

test('splitGroup works on names and on container objects',()=>{
 assert.deepEqual(splitGroup(['media-web','new'],index),{free:['new'],covered:['media-web'],owners:[{siteId:'media',name:'Gallery'}]});
 const split=splitGroup([{name:'media-web'},{name:'media-db'},{name:'paper-redis'}],index,name);
 assert.equal(split.free.length,0);
 assert.equal(coveredCaption(split),'3 more services already backed up in Gallery, Paperless');
});

test('the hidden caption names at most three apps',()=>{
 const owner=n=>({owners:[{siteId:'s'+n,name:'App '+n}]});
 assert.equal(hiddenCaption([owner(1)]),'Hidden because other apps already back them up: App 1.');
 assert.equal(hiddenCaption([1,2,3,4,5].map(owner)),'Hidden because other apps already back them up: App 1, App 2, App 3 and 2 more.');
});

test('overlaps names taken containers and static folders',()=>{
 const taken=overlaps({kind:'docker',containers:['media-db','fresh']},index);
 assert.deepEqual(taken.items,['media-db']);
 assert.equal(overlapMessage(taken),'media-db is already backed up in Gallery. Edit that app instead.');
 const two=overlaps({kind:'docker',containers:['media-web','paper-redis']},index);
 assert.equal(overlapMessage(two),'media-web, paper-redis are already backed up in Gallery, Paperless. Edit those apps instead.');
 assert.equal(overlapMessage(overlaps({kind:'static',containers:[],documentRoot:'/var/www/blog'},index)),'/var/www/blog is already backed up in Blog. Edit that app instead.');
});

test('what an edited app already had stays free for it, in the wizard and on the server alike',()=>{
 // An install from before this check: Legacy also backs up media-db, and Old blog the same folder as Blog.
 const legacy={id:'legacy',name:'Legacy',serverId:'host',config:{kind:'docker',containers:['legacy-web','media-db']}};
 const own=coverageIndex([...sites,legacy],'host',{exceptSiteId:'legacy',keep:legacy.config});
 assert.equal(own.containers.has('media-db'),false);
 assert.equal(own.containers.has('media-web'),true);
 assert.deepEqual(overlaps(legacy.config,own).items,[]);
 assert.deepEqual(overlaps({...legacy.config,containers:[...legacy.config.containers,'paper-redis']},own).items,['paper-redis']);
 const {shown}=availableChoices([{id:'compose:media',kind:'compose',containers:[{name:'media-web'},{name:'media-db'}]}],own,name);
 assert.deepEqual(shown[0].containers,[{name:'media-db'}],'its own shared container stays selectable');
 const blog={kind:'static',containers:[],documentRoot:'/var/www/blog'};
 assert.deepEqual(overlaps(blog,coverageIndex(sites,'host',{exceptSiteId:'old-blog',keep:blog})).items,[]);
 assert.deepEqual(overlaps(blog,coverageIndex(sites,'host',{exceptSiteId:'old-blog',keep:{...blog,documentRoot:'/var/www/old'}})).items,['/var/www/blog']);
});
