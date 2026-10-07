(function(){
var HUES={Women:330,Men:215,Designer:270,Kids:40,Home:150,Electronics:195,"Books & Media":20,"Hobbies & Collectables":300,Sports:170};
var CATS=Object.keys(HUES), CHIPS=["All","Women","Men","Designer","Kids","Home"];
var CONDS=["New with tags","Very good","Good","Satisfactory"];
var SHIP=[{k:"home",n:"Home delivery",p:99},{k:"pickup",n:"Pickup point",p:59},{k:"meet",n:"Meet and collect",p:0}];
function fee(p){return Math.round((15+0.05*p)*100)/100}
// Indian rupees with Indian digit grouping (1,00,000); paise shown only when present.
var INR=new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",minimumFractionDigits:0,maximumFractionDigits:2});
function inr(n){n=Math.round(Number(n)*100)/100;return n%1?INR.format(n).replace(/(\.\d)$/,"$10"):INR.format(n)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function ago(t){var s=Math.max(1,(Date.now()-t)/1000|0);if(s<60)return "now";if(s<3600)return (s/60|0)+"m";if(s<86400)return (s/3600|0)+"h";return (s/86400|0)+"d"}
var D={items:[],sellers:[],convsB:[],convsS:[],ordersB:[],ordersS:[],notifs:[],reviews:[],me:{favs:[],tcAccepted:false,prefs:[],notifSeen:0},ready:{},msgs:[]};
var U=null,db=null,sb=null,deferredInstall=null,smp=null,canWrite=true,stack=[],tab="home",dirty=false,toastT;
var UI={cat:"All",q:"",sort:"new",cond:"",maxp:"",fil:false,inboxTab:"messages",ordTab:"bought",ordF:"All",form:null,ck:{ship:"home",pay:"card",name:"",street:"",city:""},tr:false,trans:{},offerOpen:false,photos:[],busy:false};
var subs=[],chatUnsub=null;

/* ---------- data helpers ---------- */
function cl(d){var x=JSON.parse(JSON.stringify(d.data()||{}));x.id=d.id;return x}
function by(arr,id){for(var i=0;i<arr.length;i++)if(arr[i].id===id)return arr[i]}
function item(id){return by(D.items,id)}
function seller(id){return by(D.sellers,id)}
function handle(id){var s=seller(id);return s?s.handle:"member"}
function mySeller(){return seller(U)}
function convs(){return D.convsB.concat(D.convsS.filter(function(c){return c.buyerId!==c.sellerId}))}
function orders(){return D.ordersB.concat(D.ordersS.filter(function(o){return o.buyerId!==o.sellerId}))}
function rating(id){var r=D.reviews.filter(function(x){return x.toId===id});if(!r.length)return null;return {avg:r.reduce(function(a,x){return a+x.rating},0)/r.length,n:r.length}}
function isFav(id){return D.me.favs.indexOf(id)>-1}
function unreadCount(){return convs().filter(unread).length}
function unread(c){var mine=c.buyerId===U?"readB":"readS";return c.lastFrom&&c.lastFrom!==U&&(c.lastAt||0)>(c[mine]||0)}
function newNotifs(){return D.notifs.filter(function(n){return n.at>(D.me.notifSeen||0)}).length}
function toast(m){var d=document.createElement("div");d.className="toast";d.textContent=m;document.getElementById("app").appendChild(d);clearTimeout(toastT);toastT=setTimeout(function(){d.remove()},2200)}
async function w(fn,ok){if(!canWrite){toast("You have view-only access, so changes are off");return false}
  try{await fn();if(ok)toast(ok);return true}catch(e){toast("Could not save ("+(e&&e.code||"error")+")");return false}}
function rpc(fn,args){return sb.rpc(fn,args).then(function(r){if(r.error)throw {code:r.error.code,message:r.error.message};if(db&&db.ping)db.ping();return r})}
function saveMe(){return db.doc("data/users/"+U+"/me").set(D.me)}
function notify(toId,text,ref){if(!toId||toId===U||toId.indexOf("seed_")===0)return Promise.resolve();return db.collection("notifs").add({toId:toId,text:text,at:Date.now(),ref:ref||null})}

/* ---------- views ---------- */
var HEART='<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1.2 8.6 3 5 6.5 5c2 0 3.6 1.1 5.5 3 1.9-1.9 3.5-3 5.5-3C21 5 22.8 8.6 21.5 11.8 19.5 16.4 12 21 12 21z"/></svg>';
function bg(i){if(i.photos&&i.photos[0])return "background-image:url("+i.photos[0]+")";var h=i.hue==null?180:i.hue;return "background:linear-gradient(150deg,hsl("+h+",38%,38%),hsl("+((h+30)%360)+",42%,20%))"}
function ph(i,extra){return '<div class="ph" style="'+bg(i)+'">'+((i.photos&&i.photos[0])?"":esc((i.brand||i.title||"?").slice(0,2).toUpperCase()))+(extra||"")+'</div>'}
function card(i){var f=isFav(i.id);var tag=i.status==="sold"?'<span class="tag">Sold</span>':i.status==="reserved"?'<span class="tag">Reserved</span>':"";
 return '<div><button class="card" data-a="item" data-i="'+i.id+'" aria-label="'+esc(i.title)+'">'+ph(i,tag+'<span class="heart'+(f?" on":"")+'" data-a="fav" data-i="'+i.id+'" role="button" aria-label="Favourite" aria-pressed="'+f+'">'+HEART+'</span>')+'<div class="t">'+esc(i.title)+'</div><div class="m">'+esc(i.cond)+' · '+esc(i.brand||"No brand")+'</div><div class="price">'+inr(i.price)+'<small>'+inr(i.price+fee(i.price))+' incl.</small></div></button></div>'}
function row(ic,l,v,attr,tog){return '<button class="row" '+attr+'><span class="ic">'+ic+'</span><span class="l">'+l+'</span>'+(v!==""&&v!=null?'<span class="v">'+v+'</span>':'')+(tog||'<span class="chev"></span>')+'</button>'}
function head(title,back,right){return '<div class="bar">'+(back?'<button class="back" data-a="back" aria-label="Back"><span class="chev" style="transform:rotate(-135deg);margin-left:4px"></span></button>':'')+'<h1>'+title+'</h1>'+(right||"")+'</div>'}
function sw(on){return '<span class="toggle" role="switch" aria-checked="'+!!on+'"></span>'}

function feed(){
 var q=UI.q.trim().toLowerCase(),mp=parseFloat(UI.maxp);
 var v=D.items.filter(function(i){
  if(i.status==="sold")return false;
  var s=seller(i.sellerId);if(s&&s.holiday&&i.sellerId!==U)return false;
  if(UI.cat!=="All"&&i.cat!==UI.cat)return false;
  if(UI.cond&&i.cond!==UI.cond)return false;
  if(mp>0&&i.price>mp)return false;
  return !q||(i.title+" "+(i.brand||"")+" "+(i.desc||"")+" "+handle(i.sellerId)).toLowerCase().indexOf(q)>-1});
 var pr=D.me.prefs||[];
 v.sort(function(a,b){if(UI.sort==="lo")return a.price-b.price;if(UI.sort==="hi")return b.price-a.price;
  var pa=pr.indexOf(a.cat)>-1?1:0,pb=pr.indexOf(b.cat)>-1?1:0;if(pa!==pb)return pb-pa;return (b.at||0)-(a.at||0)});
 return v}
function gridHTML(){var v=feed();return v.length?v.map(card).join(""):'<div class="empty" style="grid-column:1/-1"><h2>No items found</h2>Try a different search, category or filter.</div>'}

var V={};
V.welcome=function(){return '<div style="padding-top:8vh"><h1>Welcome</h1><p class="muted">Pick a username. Other members see it on your listings and messages.</p>'+
 '<label class="field"><span>Username</span><input class="inp" id="wh" maxlength="20" placeholder="e.g. sam_thrifts" autocomplete="off"></label><p class="bad small" id="werr"></p><button class="btn block" data-a="join">Start</button></div>'};
V.home=function(){
 var chips=CHIPS.slice();if(chips.indexOf(UI.cat)<0)chips.push(UI.cat);
 return '<div style="display:flex;gap:8px;margin-bottom:12px"><div class="search" style="flex:1"><span class="muted">&#9906;</span><input id="q" type="search" placeholder="Search for items or members" value="'+esc(UI.q)+'" aria-label="Search"></div><button class="chip'+(UI.fil?' on':'')+'" data-a="fil">Filters</button></div>'+
 (UI.fil?'<div class="banner"><div class="two"><label class="field"><span>Sort</span><select class="inp" id="fs"><option value="new"'+(UI.sort==="new"?" selected":"")+'>Newest</option><option value="lo"'+(UI.sort==="lo"?" selected":"")+'>Price: low to high</option><option value="hi"'+(UI.sort==="hi"?" selected":"")+'>Price: high to low</option></select></label><label class="field"><span>Condition</span><select class="inp" id="fc"><option value="">Any</option>'+CONDS.map(function(c){return '<option'+(UI.cond===c?" selected":"")+'>'+c+'</option>'}).join("")+'</select></label></div><label class="field"><span>Max price (₹)</span><input class="inp" id="fm" inputmode="decimal" value="'+esc(UI.maxp)+'" placeholder="No limit"></label></div>':'')+
 '<div class="chips">'+chips.map(function(c){return '<button class="chip'+(c===UI.cat?' on':'')+'" data-a="cat" data-i="'+esc(c)+'">'+esc(c)+'</button>'}).join("")+'</div>'+
 (D.me.tcAccepted?'':'<div class="banner"><b>Updates to our T&amp;Cs</b><span class="muted small">The updated Terms &amp; Conditions take effect on 5 October 2026.</span><div style="margin-top:8px"><button class="btn sm" data-a="go" data-i="tc">Review T&amp;Cs</button></div></div>')+
 (canWrite?'':'<div class="banner warn small">You have view-only access. You can browse but not post, message or buy.</div>')+
 '<div class="grid" id="grid">'+gridHTML()+'</div>'+
 (D.me.shipDismissed?'':'<div class="banner" style="display:flex;gap:10px;align-items:center;margin-top:14px"><span class="small" style="flex:1">Shipping fees are added at checkout</span><button class="back" data-a="shipx" aria-label="Dismiss" style="width:28px;height:28px">&times;</button></div>')};
V.browse=function(){return head("Browse")+'<div class="search"><span class="muted">&#9906;</span><input id="q2" type="search" placeholder="Search for items or members" aria-label="Search"></div><div class="tiles">'+CATS.map(function(c){var n=D.items.filter(function(i){return i.cat===c&&i.status!=="sold"}).length;return '<button class="tile" data-a="browse" data-i="'+esc(c)+'" style="background:linear-gradient(150deg,hsl('+HUES[c]+',40%,36%),hsl('+((HUES[c]+30)%360)+',45%,20%))"><span>'+esc(c)+'<br><small style="opacity:.8;font-weight:500">'+n+' items</small></span></button>'}).join("")+'</div>'};
V.sell=function(p){
 var e=p&&item(p),f=UI.form||(UI.form=e?{id:e.id,title:e.title,desc:e.desc||"",cat:e.cat,cond:e.cond,brand:e.brand||"",size:e.size||"",price:String(e.price),photos:(e.photos||[]).slice()}:{title:"",desc:"",cat:"",cond:"Good",brand:"",size:"",price:"",photos:[]});
 return head(e?"Edit listing":"Sell an item",!!e)+
 '<label class="upl" for="file">+ Upload photos (up to 3)<input id="file" type="file" accept="image/*" multiple hidden></label>'+
 '<div class="thumbs" id="thumbs">'+f.photos.map(function(u,k){return '<button class="ph" data-a="rmph" data-i="'+k+'" style="background-image:url('+u+')" aria-label="Remove photo"><span class="tag">&times;</span></button>'}).join("")+'</div>'+
 '<label class="field"><span>Title</span><input class="inp" id="st" maxlength="80" placeholder="Tell buyers what you\'re selling" value="'+esc(f.title)+'"></label>'+
 '<label class="field"><span>Description</span><textarea class="inp" id="sd" maxlength="1000" placeholder="Tell buyers more about it">'+esc(f.desc)+'</textarea></label>'+
 '<label class="field"><span>Category</span><select class="inp" id="sc"><option value="">Select a category</option>'+CATS.map(function(c){return '<option'+(f.cat===c?' selected':'')+'>'+esc(c)+'</option>'}).join("")+'</select></label>'+
 '<div class="two"><label class="field"><span>Condition</span><select class="inp" id="sn">'+CONDS.map(function(c){return '<option'+(f.cond===c?' selected':'')+'>'+c+'</option>'}).join("")+'</select></label><label class="field"><span>Size</span><input class="inp" id="sz" maxlength="20" placeholder="Optional" value="'+esc(f.size)+'"></label></div>'+
 '<label class="field"><span>Brand</span><input class="inp" id="sb" maxlength="40" placeholder="Optional" value="'+esc(f.brand)+'"></label>'+
 '<label class="field"><span>Price (₹)</span><input class="inp" id="sp" inputmode="decimal" placeholder="0.00" value="'+esc(f.price)+'"></label>'+
 '<p class="muted small" id="sfee">'+feeText(f.price)+'</p><button class="btn block" data-a="saveitem" data-i="'+(e?e.id:"")+'">'+(e?"Save changes":"Upload")+'</button>'+
 (e?'<button class="btn danger block" style="margin-top:8px" data-a="delitem" data-i="'+e.id+'">'+(UI.confirmDel===e.id?"Tap again to delete for good":"Delete listing")+'</button>':'')};
function feeText(p){p=parseFloat(p);return p>0?"Buyers will see "+inr(p+fee(p))+" including Buyer Protection.":""}
V.item=function(id){
 var i=item(id);if(!i)return head("Item",true)+'<div class="empty"><h2>Item not found</h2>It may have been removed.</div>';
 var s=seller(i.sellerId),mine=i.sellerId===U,r=rating(i.sellerId),c=by(convs(),U+"__"+i.id)||by(convs(),i.id+"_"+U),agreed=c&&c.agreed;
 var photos=(i.photos&&i.photos.length)?i.photos:[null];
 return head("",true,'<button class="back" data-a="fav" data-i="'+i.id+'" aria-label="Favourite" aria-pressed="'+isFav(i.id)+'"><span class="heart'+(isFav(i.id)?" on":"")+'" style="position:static;background:none">'+HEART+'</span></button>')+
 '<div class="gallery">'+photos.map(function(u){return '<div class="ph" style="'+(u?"background-image:url("+u+")":bg(i))+'">'+(u?"":esc((i.brand||i.title).slice(0,2).toUpperCase()))+(i.status!=="active"?'<span class="tag">'+(i.status==="sold"?"Sold":"Reserved")+'</span>':'')+'</div>'}).join("")+'</div>'+
 '<h2>'+esc(i.title)+'</h2><div class="price" style="font-size:1.2rem;margin:4px 0">'+(agreed?'<s class="muted">'+inr(i.price)+'</s> ':'')+inr(agreed||i.price)+'<small>'+inr((agreed||i.price)+fee(agreed||i.price))+' incl. Buyer Protection</small></div>'+
 (s&&s.bundle?'<div class="pill ok" style="display:inline-block">Bundle discount: '+(s.bundlePct||10)+'% off 2+ items from this member</div>':'')+
 '<dl class="kv"><dt>Condition</dt><dd>'+esc(i.cond)+'</dd><dt>Brand</dt><dd>'+esc(i.brand||"Not stated")+'</dd><dt>Size</dt><dd>'+esc(i.size||"Not stated")+'</dd><dt>Category</dt><dd>'+esc(i.cat)+'</dd><dt>Posted</dt><dd>'+ago(i.at||Date.now())+' ago</dd></dl>'+
 (i.desc?'<p>'+esc(i.desc).replace(/\n/g,"<br>")+'</p>':'')+
 '<button class="itemcard" data-a="member" data-i="'+i.sellerId+'" style="margin:12px 0"><span class="av" style="background:hsl('+((i.hue||180))+',40%,32%)">'+esc(handle(i.sellerId).slice(0,1).toUpperCase())+'</span><span style="flex:1"><b>'+esc(handle(i.sellerId))+'</b><br><span class="muted small">'+(r?"★ "+r.avg.toFixed(1)+" ("+r.n+" reviews)":"No reviews yet")+'</span></span><span class="chev"></span></button>'+
 (mine?'<div class="two"><button class="btn ghost" data-a="edit" data-i="'+i.id+'">Edit</button><button class="btn ghost" data-a="bump" data-i="'+i.id+'">Bump to top</button></div>':
  (i.status==="active"?'<div class="two"><button class="btn ghost" data-a="chat" data-i="'+i.id+'">Make an offer</button><button class="btn" data-a="checkout" data-i="'+i.id+'">Buy now</button></div><button class="btn ghost block" style="margin-top:8px" data-a="chat" data-i="'+i.id+'" data-j="msg">Message seller</button>':'<div class="banner">This item is no longer available.</div>'))+
 (mine?'':'<button class="small muted" style="margin-top:14px;text-decoration:underline" data-a="report" data-i="'+i.id+'">Report this listing</button>')};
V.member=function(id){
 var s=seller(id)||{handle:"member"},v=D.items.filter(function(i){return i.sellerId===id&&i.status!=="sold"}),r=rating(id),rv=D.reviews.filter(function(x){return x.toId===id}).sort(function(a,b){return b.at-a.at});
 return head(esc(s.handle),true)+'<div class="banner"><b>'+(r?"★ "+r.avg.toFixed(1):"No reviews yet")+'</b><span class="muted small">'+(r?r.n+" reviews · ":"")+v.length+' items for sale'+(s.holiday?" · On holiday":"")+'</span></div>'+
 (v.length&&!s.holiday?'<div class="grid">'+v.map(card).join("")+'</div>':'<div class="empty">Nothing for sale right now.</div>')+
 (rv.length?'<h3 style="margin:18px 0 8px">Reviews</h3><div class="list">'+rv.map(function(x){return '<div class="row"><span class="l"><b>'+"★".repeat(x.rating)+'</b> '+esc(handle(x.fromId))+'<br><span class="muted small">'+esc(x.text||"")+'</span></span></div>'}).join("")+'</div>':'')};
V.inbox=function(){
 var cs=convs().sort(function(a,b){return (b.lastAt||0)-(a.lastAt||0)}),n=D.notifs.slice().sort(function(a,b){return b.at-a.at});
 var body=UI.inboxTab==="messages"?(cs.length?'<div class="list">'+cs.map(function(c){var other=c.buyerId===U?c.sellerId:c.buyerId;return '<button class="row" data-a="openchat" data-i="'+c.id+'"><span class="av" style="background:hsl('+(c.hue||180)+',40%,32%)">'+esc(handle(other).slice(0,1).toUpperCase())+'</span><span class="l"><b>'+esc(handle(other))+'</b><br><span class="muted small">'+esc(c.itemTitle)+' · '+inr(c.itemPrice)+'</span><br><span class="small">'+esc(c.lastText||"")+'</span></span><span class="v small">'+ago(c.lastAt||Date.now())+(unread(c)?' <span class="dot">1</span>':'')+'</span></button>'}).join("")+'</div>':'<div class="empty"><h2>No messages yet</h2>Open an item and tap Message seller to start a chat.</div>')
 :(n.length?'<div class="list">'+n.map(function(x){return '<button class="row" '+(x.ref?'data-a="go" data-i="'+esc(x.ref.v)+'" data-j="'+esc(x.ref.p||"")+'"':'')+'><span class="ic">!</span><span class="l">'+esc(x.text)+'<br><span class="muted small">'+ago(x.at)+' ago</span></span></button>'}).join("")+'</div>':'<div class="empty"><h2>No notifications</h2>Offers, orders and updates show up here.</div>');
 return head("Inbox")+'<div class="tabs"><button class="'+(UI.inboxTab==="messages"?'on':'')+'" data-a="itab" data-i="messages">Messages ('+cs.length+')</button><button class="'+(UI.inboxTab==="notifications"?'on':'')+'" data-a="itab" data-i="notifications">Notifications ('+n.length+')</button></div>'+body};
V.chat=function(cid){
 var c=by(convs(),cid);if(!c)return head("Chat",true)+'<div class="empty">Conversation not found.</div>';
 var i=item(c.itemId)||{title:c.itemTitle,price:c.itemPrice,hue:c.hue,status:"active",sellerId:c.sellerId,id:c.itemId},other=c.buyerId===U?c.sellerId:c.buyerId,iAmBuyer=c.buyerId===U;
 var ms=D.msgs.slice().sort(function(a,b){return a.at-b.at});
 return head(esc(handle(other)),true)+
 '<button class="itemcard" data-a="item" data-i="'+esc(i.id)+'">'+ph(i)+'<span style="min-width:0;flex:1"><b>'+esc(i.title)+'</b><span class="price" style="display:block">'+inr(i.price)+'<small>'+inr(i.price+fee(i.price))+' incl. Buyer Protection</small></span>'+(c.agreed?'<span class="ok small">Agreed price '+inr(c.agreed)+'</span>':'')+'</span></button>'+
 (iAmBuyer&&i.status==="active"?'<div class="two" style="margin-top:8px"><button class="btn ghost" data-a="offer">Make an offer</button><button class="btn" data-a="checkout" data-i="'+i.id+'">Buy now</button></div>':'')+
 (UI.offerOpen?'<div class="composer" style="position:static;padding:8px 0"><input class="inp" id="ofr" inputmode="decimal" placeholder="Your offer (₹)" aria-label="Offer amount"><button class="btn" data-a="sendoffer">Send</button></div>':'')+
 '<div class="banner warn" style="margin-top:12px"><b>Not using our system risks your purchase</b><span class="small">If you do not check out through the app, you are not covered by the refund policy.</span></div>'+
 '<div class="muted small">'+esc(handle(other))+'</div>'+
 (smp?'<button class="chip" data-a="trans" style="margin-top:8px">'+(UI.tr?"Show original":"Translate this conversation")+'</button>':'')+
 '<div class="msgs">'+(ms.length?ms.map(function(m){var me=m.from===U;
   if(m.type==="sys")return '<div class="bub sys">'+esc(m.text)+'</div>';
   if(m.type==="offer"){var st=m.status||"pending";return '<div class="bub offer '+(me?"me":"")+'" style="'+(me?"align-self:flex-end":"")+'"><b>Offer: '+inr(m.amount)+'</b><br><span class="small '+(st==="accepted"?"ok":st==="declined"?"bad":"muted")+'">'+st+'</span>'+(st==="pending"&&!me&&c.sellerId===U?'<div class="two" style="margin-top:8px"><button class="btn sm" data-a="accept" data-i="'+m.id+'">Accept</button><button class="btn ghost sm" data-a="decline" data-i="'+m.id+'">Decline</button></div>':'')+'</div>'}
   var t=UI.tr&&UI.trans[m.id];return '<div class="bub '+(me?"me":"")+'">'+esc(t||m.text)+(t&&t!==m.text?'<span class="tr">translated</span>':'')+'</div>'}).join(""):'<div class="bub sys">Say hello to start the conversation.</div>')+'</div>'+
 '<form class="composer" id="cf"><input class="inp" id="cm" placeholder="Write a message here" aria-label="Message" autocomplete="off"><button class="btn" type="submit">Send</button></form>'};
V.checkout=function(id){
 var i=item(id);if(!i||i.status!=="active")return head("Checkout",true)+'<div class="empty"><h2>No longer available</h2></div>';
 var c=by(convs(),i.id+"_"+U),base=(c&&c.agreed)||i.price,sh=by(SHIP.map(function(x){return {id:x.k,p:x.p,n:x.n}}),UI.ck.ship),f=fee(base),tot=base+f+sh.p,k=UI.ck;
 return head("Checkout",true)+'<div class="itemcard">'+ph(i)+'<span style="flex:1;min-width:0"><b>'+esc(i.title)+'</b><br><span class="muted small">Sold by '+esc(handle(i.sellerId))+'</span></span></div>'+
 '<h3 style="margin:16px 0 6px">Delivery</h3><div class="list">'+SHIP.map(function(x){return '<button class="row" data-a="ship" data-i="'+x.k+'"><span class="ic">'+(k.ship===x.k?"✓":"")+'</span><span class="l">'+x.n+'</span><span class="v">'+(x.p?inr(x.p):"Free")+'</span></button>'}).join("")+'</div>'+
 (k.ship!=="meet"?'<label class="field"><span>Full name</span><input class="inp" id="ckn" value="'+esc(k.name)+'"></label><label class="field"><span>Street address</span><input class="inp" id="cks" value="'+esc(k.street)+'"></label><label class="field"><span>City and postcode</span><input class="inp" id="ckc" value="'+esc(k.city)+'"></label>':'')+
 '<h3 style="margin:8px 0 6px">Payment</h3><div class="list">'+[["card","Card ending 4242 (demo)"],["wallet","Wallet balance ("+inr((mySeller()||{}).balance||0)+")"]].map(function(x){return '<button class="row" data-a="pay" data-i="'+x[0]+'"><span class="ic">'+(k.pay===x[0]?"✓":"")+'</span><span class="l">'+x[1]+'</span></button>'}).join("")+'</div>'+
 '<div class="sum"><span>Item'+(c&&c.agreed?" (agreed offer)":"")+'</span><span>'+inr(base)+'</span></div><div class="sum"><span>Buyer Protection</span><span>'+inr(f)+'</span></div><div class="sum"><span>'+sh.n+'</span><span>'+inr(sh.p)+'</span></div><div class="sum total"><span>Total</span><span>'+inr(tot)+'</span></div>'+
 '<p class="muted small">Payments are simulated in this app. No real money moves.</p><button class="btn block" data-a="placeorder" data-i="'+i.id+'">'+(UI.busy?"Processing…":"Pay "+inr(tot))+'</button>'};
V.orders=function(){
 var map={"In Progress":["paid","shipped"],Completed:["completed"],Cancelled:["cancelled"]};
 var o=orders().filter(function(x){var mine=UI.ordTab==="bought"?x.buyerId===U:x.sellerId===U;return mine&&(UI.ordF==="All"||map[UI.ordF].indexOf(x.status)>-1)}).sort(function(a,b){return b.at-a.at});
 return head("My orders",true)+'<div class="tabs"><button class="'+(UI.ordTab==="sold"?'on':'')+'" data-a="otab" data-i="sold">Sold</button><button class="'+(UI.ordTab==="bought"?'on':'')+'" data-a="otab" data-i="bought">Bought</button></div>'+
 '<div class="chips">'+["All","In Progress","Cancelled","Completed"].map(function(x){return '<button class="chip'+(x===UI.ordF?' on':'')+'" data-a="of" data-i="'+x+'">'+x+'</button>'}).join("")+'</div>'+
 (o.length?'<div class="list">'+o.map(function(x){return '<button class="row" data-a="order" data-i="'+x.id+'"><span class="l"><b>'+esc(x.title)+'</b><br><span class="price muted">'+inr(UI.ordTab==="sold"?x.price:x.total)+'</span></span><span class="pill '+(x.status==="completed"?"ok":x.status==="cancelled"?"bad":"prog")+'">'+stLabel(x.status)+'</span></button>'}).join("")+'</div>':'<div class="empty"><h2>No orders yet</h2>When something is '+UI.ordTab+', it will be listed here.</div>')};
function stLabel(s){return {paid:"Paid",shipped:"Shipped",completed:"Order completed",cancelled:"Cancelled"}[s]||s}
V.order=function(id){
 var o=by(orders(),id);if(!o)return head("Order",true)+'<div class="empty">Order not found.</div>';
 var buyer=o.buyerId===U,steps=["paid","shipped","completed"],idx=steps.indexOf(o.status),rv=by(D.reviews,o.id+"_"+U),other=buyer?o.sellerId:o.buyerId;
 return head("Order",true)+'<h2>'+esc(o.title)+'</h2><p class="muted small">'+(buyer?"Bought from ":"Sold to ")+esc(handle(other))+' · '+ago(o.at)+' ago</p>'+
 (o.status==="cancelled"?'<div class="banner"><b>Cancelled</b><span class="small muted">The item is back on sale.</span></div>':'<div class="steps">'+steps.map(function(s,k){return '<i class="'+(k<=idx?"on":"")+'"></i>'}).join("")+'</div><p><b>'+stLabel(o.status)+'</b></p>')+
 '<div class="sum"><span>Item</span><span>'+inr(o.price)+'</span></div><div class="sum"><span>Buyer Protection</span><span>'+inr(o.fee)+'</span></div><div class="sum"><span>Delivery</span><span>'+inr(o.ship)+'</span></div><div class="sum total"><span>Total paid</span><span>'+inr(o.total)+'</span></div>'+
 (o.addr?'<p class="muted small">Delivery to: '+esc(o.addr)+'</p>':'')+
 (o.status==="paid"&&!buyer?'<button class="btn block" data-a="ostat" data-i="'+o.id+'" data-j="shipped">Mark as shipped</button>':'')+
 (o.status==="shipped"&&buyer?'<button class="btn block" data-a="ostat" data-i="'+o.id+'" data-j="completed">Confirm item received</button>':'')+
 (o.status==="paid"?'<button class="btn danger block" style="margin-top:8px" data-a="ostat" data-i="'+o.id+'" data-j="cancelled">Cancel order</button>':'')+
 (o.status==="completed"&&buyer&&!rv?'<h3 style="margin:16px 0 6px">Rate '+esc(handle(o.sellerId))+'</h3><div class="stars" id="stars">'+[1,2,3,4,5].map(function(n){return '<button data-a="star" data-i="'+n+'" class="'+(UI.stars>=n?"on":"")+'" aria-label="'+n+' stars">★</button>'}).join("")+'</div><label class="field"><span>Comment</span><textarea class="inp" id="rvt" maxlength="300"></textarea></label><button class="btn block" data-a="review" data-i="'+o.id+'">Submit review</button>':'')+
 (rv?'<div class="banner"><b>Your review: '+"★".repeat(rv.rating)+'</b><span class="small muted">'+esc(rv.text||"")+'</span></div>':'')+
 '<button class="btn ghost block" style="margin-top:8px" data-a="item" data-i="'+esc(o.itemId)+'">View item</button>'};
V.profile=function(){
 var s=mySeller()||{handle:"you"},mine=D.items.filter(function(i){return i.sellerId===U}),r=rating(U),sold=D.ordersS.filter(function(o){return o.status==="completed"}).length,badges=(mine.length?1:0)+(sold?1:0);
 return '<div class="bar"><span class="av" style="background:var(--accent);color:var(--accent-ink)">'+esc(s.handle.slice(0,1).toUpperCase())+'</span><div style="flex:1;min-width:0"><h2>'+esc(s.handle)+'</h2><button class="small" style="color:var(--accent);font-weight:600" data-a="go" data-i="mine">View my listings ('+mine.length+')</button></div></div>'+
 '<div class="banner"><b>Badges you earned</b><span class="muted small">'+badges+' of 2 · '+(mine.length?"First listing ✓":"First listing")+' · '+(sold?"First sale ✓":"First sale")+(r?" · ★ "+r.avg.toFixed(1):"")+'</span></div>'+
 '<div class="list">'+row("♥","Favourite items",D.me.favs.length,'data-a="go" data-i="favs"')+row("₹","Earn ₹500 from referrals","",'data-a="go" data-i="ref"')+row("B","Balance",inr(s.balance||0),'data-a="go" data-i="bal"')+row("O","My orders","",'data-a="go" data-i="orders"')+row("P","Promotional tools","",'data-a="go" data-i="promo"')+row("*","Personalisation",(D.me.prefs||[]).length?(D.me.prefs.length+" picked"):"",'data-a="go" data-i="pers"')+
 row("%","Bundle discounts",s.bundle?"On":"Off",'data-a="bundle"',sw(s.bundle))+row("H","Holiday mode",s.holiday?"On":"Off",'data-a="go" data-i="holiday"')+'</div>'+
 '<div class="list">'+row("?","Your guide to the app","",'data-a="go" data-i="doc" data-j="how"')+row("i","Help Centre","",'data-a="go" data-i="help"')+row("S","Settings","",'data-a="go" data-i="settings"')+row("C","Cookie settings","",'data-a="go" data-i="cookies"')+row("A","About us","",'data-a="go" data-i="about"')+row("§","Legal information","",'data-a="go" data-i="legal"')+row("P","Our platform","",'data-a="go" data-i="doc" data-j="platform"')+'</div>'};
V.favs=function(){var v=D.items.filter(function(i){return isFav(i.id)});return head("Favourite items",true)+(v.length?'<div class="grid">'+v.map(card).join("")+'</div>':'<div class="empty"><h2>No favourites yet</h2>Tap the heart on an item to save it.</div>')};
V.mine=function(){var v=D.items.filter(function(i){return i.sellerId===U}).sort(function(a,b){return b.at-a.at});var s=mySeller();return head("My listings",true)+(s&&s.holiday?'<div class="banner warn small">Holiday mode is on. Other members cannot see your items.</div>':'')+(v.length?'<div class="grid">'+v.map(card).join("")+'</div>':'<div class="empty"><h2>No listings yet</h2>Use the Sell tab to upload your first item.</div>')};
V.holiday=function(){var s=mySeller()||{};return head("Holiday mode",true)+'<div class="list">'+row("H","Hide my items","",'data-a="hol"',sw(s.holiday))+'</div><p class="muted small">While this is on, your listings are hidden from the feed and search.</p>'};
V.bal=function(){var s=mySeller()||{};var rows=D.ordersS.filter(function(o){return o.status==="completed"});return head("Balance",true)+'<div class="banner"><b style="font-size:1.6rem">'+inr(s.balance||0)+'</b><span class="muted small">Available. Earned from completed sales. Payouts are simulated.</span></div><button class="btn block" data-a="payout" '+((s.balance||0)>0?"":"disabled")+'>Request payout</button>'+(rows.length?'<h3 style="margin:18px 0 8px">Earnings</h3><div class="list">'+rows.map(function(o){return '<div class="row"><span class="l">'+esc(o.title)+'</span><span class="v">+'+inr(o.price)+'</span></div>'}).join("")+'</div>':'')};
V.ref=function(){var code=(mySeller()||{handle:"you"}).handle.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,8);return head("Earn ₹500 from referrals",true)+'<div class="banner"><b>Your code: '+esc(code)+'</b><span class="muted small">Friends who join and sell their first item with your code earn you ₹500. Rewards are simulated here.</span></div><button class="btn block" data-a="copy" data-i="'+esc(code)+'">Copy code</button>'};
V.promo=function(){var v=D.items.filter(function(i){return i.sellerId===U&&i.status==="active"});return head("Promotional tools",true)+'<p class="muted small">Bump a listing to move it back to the top of the feed.</p>'+(v.length?'<div class="list">'+v.map(function(i){return '<div class="row"><span class="l"><b>'+esc(i.title)+'</b><br><span class="muted small">Posted '+ago(i.at)+' ago</span></span><button class="btn sm" data-a="bump" data-i="'+i.id+'">Bump</button></div>'}).join("")+'</div>':'<div class="empty"><h2>No active listings</h2></div>')};
V.pers=function(){var p=D.me.prefs||[];return head("Personalisation",true)+'<p class="muted small">Pick categories you like. They appear first in your feed.</p><div class="chips" style="flex-wrap:wrap">'+CATS.map(function(c){return '<button class="chip'+(p.indexOf(c)>-1?' on':'')+'" data-a="pref" data-i="'+esc(c)+'">'+esc(c)+'</button>'}).join("")+'</div>'};
V.settings=function(){var s=mySeller()||{};return head("Settings",true)+'<label class="field"><span>Username</span><input class="inp" id="sethandle" maxlength="20" value="'+esc(s.handle||"")+'"></label><button class="btn block" data-a="rename">Save username</button><div class="list" style="margin-top:14px">'+row("T","Light / dark theme","",'data-a="theme"')+row("N","Order and offer notifications","",'data-a="npref"',sw(D.me.notifOff!==true))+row("+","Install app","",'data-a="install"')+row("O","Sign out","",'data-a="signout"')+'</div>'};
V.cookies=function(){return head("Cookie settings",true)+'<div class="list">'+row("E","Essential","Always on","",'<span></span>')+row("A","Analytics","Off","",'<span class="toggle" role="switch" aria-checked="false"></span>')+'</div><p class="muted small">This app sets no tracking cookies. It remembers your theme in this browser only.</p>'};
var DOCS={how:["How it works","Browse or search for items. Message a seller or make an offer. Buy now to check out inside the app, where Buyer Protection applies. The seller ships; you confirm receipt and leave a review. To sell, add photos, a title, category and price in the Sell tab."],
 platform:["Our platform","A peer-to-peer marketplace for pre-owned items. Listings, chats, offers, orders and reviews are shared live between everyone who has the page open. Payments and payouts are simulated."],
 trust:["Trust and Safety","Keep all payments inside the app. Report listings that look wrong. Never share passwords. Buyer Protection covers in-app checkout only."],
 verify:["Item Verification","Sellers describe item condition honestly and add clear photos. If an item is not as described, raise it before you confirm receipt."],
 access:["Accessibility","The app supports text zoom, light and dark themes, keyboard focus outlines and screen reader labels on icon buttons."],
 privacy:["Privacy Centre","We store your username, listings, messages, offers, orders and reviews so the app can work. Your favourites and settings are private to you. Nothing is sold or shared outside the app."],
 impressum:["Impressum","This is a prototype marketplace. It has no registered operator, and no real sales take place."],
 ack:["Acknowledgements","Fonts: Bricolage Grotesque and Figtree from Google Fonts, used under the SIL Open Font License."],
 dac7:["DAC7 centre","Platforms in the EU report seller activity to tax authorities. This prototype does not file reports. A real service would show your yearly sales and any information you must supply."],
 pro:["Pro Terms and Conditions","Rules for business sellers. Not part of this prototype."]};
V.doc=function(k){var d=DOCS[k]||["Information","No content."];return head(esc(d[0]),true)+'<p>'+esc(d[1])+'</p>'};
V.help=function(){var q=[["How do I pay?","Tap Buy now on an item and choose delivery and payment. Payment is simulated here."],["When does the seller get paid?","After you confirm the item arrived, the amount is added to the seller's balance."],["How do offers work?","Make an offer in the chat. The seller accepts or declines. If accepted, your Buy now price is the offer."],["Can I cancel an order?","Yes, until the seller marks it shipped. The item goes back on sale."],["How do I hide my items?","Turn on Holiday mode in your profile."]];
 return head("Help Centre",true)+'<div class="list">'+q.map(function(x){return '<div class="row" style="display:block"><b>'+x[0]+'</b><br><span class="muted">'+x[1]+'</span></div>'}).join("")+'</div>'};
V.about=function(){return head("About",true)+'<div class="list">'+[["Get to know us","platform"],["How it works","how"],["Item Verification","verify"],["Trust and Safety","trust"],["Accessibility","access"]].map(function(t){return row("i",t[0],"",'data-a="go" data-i="doc" data-j="'+t[1]+'"')}).join("")+'</div>'};
V.legal=function(){return head("Legal information",true)+'<div class="list">'+row("§","Terms &amp; Conditions","",'data-a="go" data-i="tc"')+[["Privacy Centre","privacy"],["Impressum","impressum"],["Acknowledgements","ack"],["Pro Terms and Conditions","pro"],["DAC7 centre","dac7"]].map(function(t){return row("§",t[0],"",'data-a="go" data-i="doc" data-j="'+t[1]+'"')}).join("")+'</div>'};
V.tc=function(){return head("User Terms and Conditions",true)+'<div class="banner"><b>Updates to our T&amp;Cs</b><span class="small muted">The updated terms take effect on 5 October 2026. Members with a balance move to a new payment-provider-managed balance. Available and pending amounts are transferred and you are told the timing.</span>'+(D.me.tcAccepted?'<p class="small ok" style="margin:8px 0 0">Accepted</p>':'<div style="margin-top:8px"><button class="btn sm" data-a="accept">Review and accept</button></div>')+'</div>'+
 '<div class="doc"><h3>1. About you and us</h3><p>Who runs the service and what the defined terms mean.</p><h3>2. Becoming a member</h3><p>Choose a unique username. Keep your account secure and report unauthorised use.</p><h3>3. Eligibility</h3><p>Members must be 18 or over.</p><h3>4. Buying and selling</h3><p>List only items you own. Describe them honestly. Complete transactions inside the app to keep Buyer Protection.</p><h3>5. Catalogue rules</h3><p>No illegal, counterfeit or unsafe items.</p><h3>6. Disputes and reporting</h3><p>Report listings or members that break these terms.</p><h3>7. Promotions</h3><p>Special offers may be run from time to time.</p><p class="small">Summary for this prototype. Not legal advice.</p></div>'};

/* ---------- render / nav ---------- */
function cur(){return stack.length?stack[stack.length-1]:{v:tab}}
function typing(){var a=document.activeElement;return a&&(a.tagName==="INPUT"||a.tagName==="TEXTAREA"||a.tagName==="SELECT")}
function render(){
 dirty=false;var main=document.getElementById("main"),nav=document.getElementById("nav");
 if(!D.ready.sellers){return}
 if(!mySeller()&&U){main.innerHTML=V.welcome();nav.hidden=true;return}
 var c=cur(),v=c.v,keep=main.scrollTop,same=main.dataset.v===v+":"+(c.p||"");
 main.innerHTML=(V[v]||V.home)(c.p);main.dataset.v=v+":"+(c.p||"");
 nav.hidden=false;
 var un=unreadCount(),nn=newNotifs();
 var tabs=[["home","Home",'<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],["browse","Browse",'<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'],["sell","Sell",'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'],["inbox","Inbox",'<path d="M4 5h16v12H8l-4 4z"/>'],["profile","Profile",'<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>']];
 nav.innerHTML=tabs.map(function(t){return '<button data-a="tab" data-i="'+t[0]+'" class="'+(!stack.length&&tab===t[0]?'on':'')+'" aria-label="'+t[1]+'"><svg viewBox="0 0 24 24">'+t[2]+'</svg>'+t[1]+(t[0]==="inbox"&&(un+nn)?' <span class="dot">'+(un+nn)+'</span>':'')+'</button>'}).join("");
 if(same)main.scrollTop=keep; else if(v==="chat")main.scrollTop=main.scrollHeight;
}
function refresh(){if(typing()){dirty=true;return}render()}
document.addEventListener("focusout",function(){setTimeout(function(){if(dirty&&!typing())render()},50)});
function go(v,p){leaveChat();UI.form=null;UI.confirmDel=null;stack.push({v:v,p:p});render();document.getElementById("main").scrollTop=0;if(v==="chat")enterChat(p)}
function leaveChat(){if(chatUnsub&&cur().v==="chat"){chatUnsub();chatUnsub=null;D.msgs=[]}}
function enterChat(cid){if(chatUnsub)chatUnsub();D.msgs=[];UI.tr=false;UI.offerOpen=false;
 chatUnsub=db.collection("convs/"+cid+"/msgs").orderBy("at").limit(300).onSnapshot(function(s){D.msgs=s.docs.map(function(d){return cl(d)});refresh();var c=by(convs(),cid);if(c&&c.lastFrom&&c.lastFrom!==U){var k=c.buyerId===U?"readB":"readS";if((c[k]||0)<(c.lastAt||0)&&canWrite){var u={};u[k]=Date.now();db.doc("convs/"+cid).update(u).catch(function(){})}}},function(){})}
function back(){leaveChat();var was=cur().v;stack.pop();UI.form=null;UI.offerOpen=false;if(cur().v==="chat"&&!chatUnsub)enterChat(cur().p);render()}

/* ---------- actions ---------- */
function resize(file){return new Promise(function(res){var r=new FileReader();r.onload=function(){var im=new Image();im.onload=function(){var m=520,s=Math.min(1,m/Math.max(im.width,im.height)),c=document.createElement("canvas");c.width=im.width*s;c.height=im.height*s;c.getContext("2d").drawImage(im,0,0,c.width,c.height);res(c.toDataURL("image/jpeg",.7))};im.onerror=function(){res(null)};im.src=r.result};r.onerror=function(){res(null)};r.readAsDataURL(file)})}
async function openConv(itemId,msgFirst){
 var i=item(itemId);if(!i)return;if(i.sellerId===U){toast("This is your own listing");return}
 var cid=i.id+"_"+U;if(!by(convs(),cid)){var ok=await w(function(){return db.doc("convs/"+cid).set({itemId:i.id,itemTitle:i.title,itemPrice:i.price,hue:i.hue==null?180:i.hue,buyerId:U,sellerId:i.sellerId,lastText:"",lastAt:Date.now(),lastFrom:null})});if(!ok)return;D.convsB.push({id:cid,itemId:i.id,itemTitle:i.title,itemPrice:i.price,hue:i.hue,buyerId:U,sellerId:i.sellerId,lastAt:Date.now()})}
 go("chat",cid);if(msgFirst==="offer"){UI.offerOpen=true;render()}}
async function sendMsg(cid,m,preview){var c=by(convs(),cid);if(!c)return false;
 return w(async function(){await db.collection("convs/"+cid+"/msgs").add(Object.assign({from:U,at:Date.now()},m));var u={lastText:preview,lastAt:Date.now(),lastFrom:U};u[c.buyerId===U?"readB":"readS"]=Date.now();await db.doc("convs/"+cid).update(u)})}
async function setOrderStatus(o,st){
 var ok=await w(async function(){
  if(st==="completed"){await rpc("rl_complete_order",{p_order:o.id})}
  else{await db.doc("orders/"+o.id).update({status:st});
  if(st==="cancelled")await rpc("rl_item_status",{p_item:o.itemId,p_status:"active"}).catch(function(){})}
  await notify(U===o.buyerId?o.sellerId:o.buyerId,"Order “"+o.title+"”: "+stLabel(st).toLowerCase(),{v:"order",p:o.id})});
 if(ok)toast("Order "+stLabel(st).toLowerCase())}

document.addEventListener("click",async function(e){
 var t=e.target.closest("[data-a]");if(!t)return;var a=t.dataset.a,i=t.dataset.i,j=t.dataset.j;
 if(a==="fav"){e.stopPropagation();e.preventDefault();var k=D.me.favs.indexOf(i);k>-1?D.me.favs.splice(k,1):D.me.favs.push(i);render();await saveMe().catch(function(){toast("Could not save favourite")});return}
 switch(a){
 case "tab": leaveChat();stack=[];tab=i;UI.form=null;if(i==="inbox"&&UI.inboxTab==="notifications"){}render();document.getElementById("main").scrollTop=0;return;
 case "back": back();return;
 case "go": go(i,j||undefined);return;
 case "item": go("item",i);return;
 case "member": go("member",i);return;
 case "cat": UI.cat=i;render();return;
 case "browse": UI.cat=i;leaveChat();stack=[];tab="home";render();return;
 case "fil": UI.fil=!UI.fil;render();return;
 case "shipx": D.me.shipDismissed=true;render();saveMe().catch(function(){});return;
 case "itab": UI.inboxTab=i;if(i==="notifications"){D.me.notifSeen=Date.now();saveMe().catch(function(){})}render();return;
 case "openchat": go("chat",i);return;
 case "chat": openConv(i,j);return;
 case "offer": UI.offerOpen=!UI.offerOpen;render();return;
 case "sendoffer": {var amt=parseFloat((document.getElementById("ofr")||{}).value);if(!(amt>0)){toast("Enter an amount above zero");return}
   var cid=cur().p,c=by(convs(),cid),it=item(c.itemId);if(it&&amt>=it.price){toast("Offer must be below the asking price");return}
   UI.offerOpen=false;if(await sendMsg(cid,{type:"offer",amount:amt,status:"pending",text:"Offer "+inr(amt)},"Offer: "+inr(amt))){await notify(c.sellerId,"New offer of "+inr(amt)+" on “"+c.itemTitle+"”",{v:"chat",p:cid});toast("Offer sent")}render();return}
 case "accept": case "decline": {var cid2=cur().p,c2=by(convs(),cid2),m=by(D.msgs,i),st=a==="accept"?"accepted":"declined";
   await w(async function(){await db.doc("convs/"+cid2+"/msgs/"+m.id).update({status:st});if(st==="accepted")await db.doc("convs/"+cid2).update({agreed:m.amount});await db.collection("convs/"+cid2+"/msgs").add({from:U,at:Date.now(),type:"sys",text:"Offer of "+inr(m.amount)+" "+st});await db.doc("convs/"+cid2).update({lastText:"Offer "+st,lastAt:Date.now(),lastFrom:U,readS:Date.now()});await notify(c2.buyerId,"Your offer on “"+c2.itemTitle+"” was "+st,{v:"chat",p:cid2})});return}
 case "trans": {UI.tr=!UI.tr;render();if(UI.tr&&smp){var need=D.msgs.filter(function(m){return m.type!=="sys"&&m.type!=="offer"&&!UI.trans[m.id]});if(need.length){try{var out=await smp.json("Translate each of these chat messages into English. If a message is already English, return it unchanged. Reply with only a JSON array of strings, same length and order.\n"+JSON.stringify(need.map(function(m){return m.text})));need.forEach(function(m,k){UI.trans[m.id]=out[k]||m.text});render()}catch(err){UI.tr=false;toast("Translation is unavailable");render()}}}return}
 case "checkout": if(!canWrite){toast("You have view-only access");return}if(item(i).sellerId===U){toast("This is your own listing");return}UI.ck.ship="home";go("checkout",i);return;
 case "ship": UI.ck.ship=i;render();return;
 case "pay": UI.ck.pay=i;render();return;
 case "placeorder": {var it2=item(i),k2=UI.ck,c3=by(convs(),i+"_"+U);if(!it2||it2.status!=="active"){toast("Item is no longer available");return}
   if(k2.ship!=="meet"&&!(k2.name.trim()&&k2.street.trim()&&k2.city.trim())){toast("Enter your delivery address");return}
   var base=(c3&&c3.agreed)||it2.price,sh=SHIP.filter(function(x){return x.k===k2.ship})[0],f2=fee(base),tot=Math.round((base+f2+sh.p)*100)/100,me=mySeller();
   if(k2.pay==="wallet"&&((me.balance||0)<tot)){toast("Not enough wallet balance");return}
   UI.busy=true;render();var ref;
   var ok=await w(async function(){await new Promise(function(r){setTimeout(r,700)});
     var fresh=await db.doc("items/"+i).get();if(!fresh.exists||fresh.data().status!=="active")throw {code:"gone"};
     ref=await db.collection("orders").add({itemId:i,title:it2.title,hue:it2.hue==null?180:it2.hue,price:base,fee:f2,ship:sh.p,total:tot,buyerId:U,sellerId:it2.sellerId,status:"paid",at:Date.now(),addr:k2.ship==="meet"?"Meet and collect":k2.name+", "+k2.street+", "+k2.city});
     await rpc("rl_item_status",{p_item:i,p_status:"sold"});
     if(k2.pay==="wallet")await db.doc("sellers/"+U).update({balance:Math.round(((me.balance||0)-tot)*100)/100});
     if(c3)await db.collection("convs/"+c3.id+"/msgs").add({from:U,at:Date.now(),type:"sys",text:"Item bought for "+inr(tot)+" with Buyer Protection"});
     await notify(it2.sellerId,"“"+it2.title+"” sold for "+inr(base),{v:"order",p:ref.id})});
   UI.busy=false;if(ok){toast("Order placed");stack.pop();go("order",ref.id)}else render();return}
 case "otab": UI.ordTab=i;render();return;
 case "of": UI.ordF=i;render();return;
 case "order": go("order",i);return;
 case "ostat": {var o=by(orders(),i);setOrderStatus(o,j);return}
 case "star": UI.stars=+i;render();return;
 case "review": {if(!UI.stars){toast("Choose a star rating");return}var o2=by(orders(),i);
   if(await w(function(){return db.doc("reviews/"+o2.id+"_"+U).set({orderId:o2.id,fromId:U,toId:o2.sellerId,rating:UI.stars,text:(document.getElementById("rvt")||{}).value||"",at:Date.now()})},"Review posted")){UI.stars=0;await notify(o2.sellerId,"You received a "+UI.stars+" star review",{v:"member",p:o2.sellerId})}return}
 case "rmph": UI.form.photos.splice(+i,1);render();return;
 case "saveitem": {var f=UI.form,p=parseFloat(f.price);if(!f.title.trim()||!f.cat||!(p>0)){toast("Add a title, category and price");return}
   var data={title:f.title.trim(),desc:f.desc.trim(),cat:f.cat,cond:f.cond,brand:f.brand.trim(),size:f.size.trim(),price:Math.round(p*100)/100,photos:f.photos,hue:HUES[f.cat]};
   var ok2;if(i){ok2=await w(function(){return db.doc("items/"+i).update(data)},"Changes saved");UI.form=null;if(ok2){stack.pop();render()}}
   else{data.sellerId=U;data.status="active";data.at=Date.now();ok2=await w(function(){return db.collection("items").add(data)},"Listing uploaded");UI.form=null;if(ok2){stack=[{v:"mine"}];tab="profile";render()}}return}
 case "edit": go("sell",i);return;
 case "delitem": if(UI.confirmDel!==i){UI.confirmDel=i;render();return}await w(function(){return db.doc("items/"+i).delete()},"Listing deleted");UI.confirmDel=null;stack=[{v:"mine"}];tab="profile";render();return;
 case "bump": await w(function(){return db.doc("items/"+i).update({at:Date.now()})},"Moved to the top");return;
 case "report": await w(function(){return db.collection("reports").add({itemId:i,by:U,at:Date.now()})},"Thanks, we will review this listing");return;
 case "join": {var hv=(document.getElementById("wh").value||"").trim(),er=document.getElementById("werr");
   if(!/^[A-Za-z0-9_]{3,20}$/.test(hv)){er.textContent="Use 3 to 20 letters, numbers or underscores.";return}
   if(mySeller()){render();return}
   if(D.sellers.some(function(s){return s.id!==U&&s.handle.toLowerCase()===hv.toLowerCase()})){er.textContent="That username is taken.";return}
   var nd={handle:hv,balance:0,holiday:false,bundle:false,bundlePct:10,joined:Date.now()};
   if(await w(function(){return db.doc("sellers/"+U).set(nd)})){if(!mySeller())D.sellers.push(Object.assign({id:U},nd));toast("Welcome, "+hv);render()}return}
 case "rename": {var nv=(document.getElementById("sethandle").value||"").trim();if(!/^[A-Za-z0-9_]{3,20}$/.test(nv)){toast("Use 3 to 20 letters, numbers or underscores");return}
   if(D.sellers.some(function(s){return s.id!==U&&s.handle.toLowerCase()===nv.toLowerCase()})){toast("That username is taken");return}
   await w(function(){return db.doc("sellers/"+U).update({handle:nv})},"Username saved");return}
 case "bundle": {var s1=mySeller();await w(function(){return db.doc("sellers/"+U).update({bundle:!s1.bundle})});return}
 case "hol": {var s2=mySeller();await w(function(){return db.doc("sellers/"+U).update({holiday:!s2.holiday})});return}
 case "payout": {var s3=mySeller();if(await w(function(){return db.doc("sellers/"+U).update({balance:0})},"Payout of "+inr(s3.balance)+" requested (simulated)")){}return}
 case "pref": {var pr=D.me.prefs||(D.me.prefs=[]),k3=pr.indexOf(i);k3>-1?pr.splice(k3,1):pr.push(i);render();saveMe().catch(function(){});return}
 case "npref": D.me.notifOff=D.me.notifOff!==true;render();saveMe().catch(function(){});return;
 case "signout": await sb.auth.signOut();location.reload();return;
 case "install": if(deferredInstall){deferredInstall.prompt();deferredInstall=null}else toast("On iPhone: Share, then Add to Home Screen. On Android: browser menu, then Install app.");return;
 case "theme": {var r=document.documentElement,dark=getComputedStyle(r).colorScheme==="dark";r.setAttribute("data-theme",dark?"light":"dark");return}
 case "accept": D.me.tcAccepted=true;render();await saveMe().catch(function(){});toast("Terms accepted");return;
 case "copy": try{await navigator.clipboard.writeText(i);toast("Code copied")}catch(err){toast("Your code is "+i)}return;
 }
});
document.addEventListener("input",function(e){var id=e.target.id,v=e.target.value,f=UI.form;
 if(id==="q"){UI.q=v;var g=document.getElementById("grid");if(g)g.innerHTML=gridHTML()}
 else if(id==="q2"){UI.q=v}
 else if(f&&id==="st")f.title=v; else if(f&&id==="sd")f.desc=v; else if(f&&id==="sb")f.brand=v; else if(f&&id==="sz")f.size=v;
 else if(f&&id==="sp"){f.price=v;document.getElementById("sfee").textContent=feeText(v)}
 else if(id==="fm"){UI.maxp=v;var g2=document.getElementById("grid");if(g2)g2.innerHTML=gridHTML()}
 else if(id==="ckn")UI.ck.name=v; else if(id==="cks")UI.ck.street=v; else if(id==="ckc")UI.ck.city=v});
document.addEventListener("change",async function(e){var id=e.target.id,v=e.target.value,f=UI.form;
 if(id==="sc"&&f)f.cat=v; else if(id==="sn"&&f)f.cond=v;
 else if(id==="fs"){UI.sort=v;var g=document.getElementById("grid");if(g)g.innerHTML=gridHTML()}
 else if(id==="fc"){UI.cond=v;var g2=document.getElementById("grid");if(g2)g2.innerHTML=gridHTML()}
 else if(id==="file"&&f){var fs=[].slice.call(e.target.files).slice(0,3-f.photos.length);for(var k=0;k<fs.length;k++){var u=await resize(fs[k]);if(u)f.photos.push(u)}render()}});
document.addEventListener("keydown",function(e){if(e.key==="Enter"&&e.target.id==="q2"){stack=[];tab="home";UI.cat="All";render()}});
document.addEventListener("submit",async function(e){e.preventDefault();if(e.target.id==="cf"){var inp=document.getElementById("cm"),v=inp.value.trim();if(!v)return;inp.value="";await sendMsg(cur().p,{type:"text",text:v},v)}});

/* ---------- boot ---------- */
function authScreen(msg){
 var m=document.getElementById("main");document.getElementById("nav").hidden=true;
 m.innerHTML='<div class="auth"><h1>Reloved</h1><p class="muted">Buy and sell pre-owned items. Sign in or create an account.</p>'+
  '<label class="field"><span>Email</span><input class="inp" id="aem" type="email" autocomplete="email"></label>'+
  '<label class="field"><span>Password</span><input class="inp" id="apw" type="password" autocomplete="current-password" minlength="6"></label>'+
  '<p class="small '+(msg&&msg.ok?"ok":"bad")+'" id="amsg">'+esc(msg?msg.t:"")+'</p>'+
  '<div class="two"><button class="btn" id="asi">Sign in</button><button class="btn ghost" id="asu">Create account</button></div></div>';
 function say(t,ok){var e=document.getElementById("amsg");e.className="small "+(ok?"ok":"bad");e.textContent=t}
 function vals(){return {email:document.getElementById("aem").value.trim(),password:document.getElementById("apw").value}}
 document.getElementById("asi").onclick=async function(){var v=vals();var r=await sb.auth.signInWithPassword(v);if(r.error)say(r.error.message);else location.reload()};
 document.getElementById("asu").onclick=async function(){var v=vals();if(v.password.length<6){say("Use a password of at least 6 characters.");return}
  var r=await sb.auth.signUp(v);if(r.error)say(r.error.message);else if(r.data.session)location.reload();else say("Check your email to confirm your account, then sign in.",true)}}
async function boot(){
 var cfg=window.APP_CONFIG||{};
 if(!window.supabase||!cfg.SUPABASE_URL||cfg.SUPABASE_URL.indexOf("YOUR-")>-1){document.getElementById("main").innerHTML='<div class="empty"><h2>Setup needed</h2>Add your Supabase URL and anon key to config.js. See README.md.</div>';return}
 sb=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
 var ses=(await sb.auth.getSession()).data.session;
 if(!ses){authScreen();return}
 U=ses.user.id;db=window.makeDb(sb,U);smp=null;canWrite=true;
 var E=function(){};
 subs.push(db.collection("items").limit(500).onSnapshot(function(s){D.items=s.docs.map(function(d){return cl(d)});D.ready.items=1;refresh()},E));
 subs.push(db.collection("sellers").limit(500).onSnapshot(function(s){D.sellers=s.docs.map(function(d){return cl(d)});D.ready.sellers=1;refresh()},E));
 subs.push(db.collection("reviews").limit(500).onSnapshot(function(s){D.reviews=s.docs.map(function(d){return cl(d)});refresh()},E));
 function mapDocs(key){return function(s){D[key]=s.docs.map(function(d){return cl(d)});refresh()}}
 subs.push(db.collection("convs").where("buyerId","==",U).limit(200).onSnapshot(mapDocs("convsB"),E));
 subs.push(db.collection("convs").where("sellerId","==",U).limit(200).onSnapshot(mapDocs("convsS"),E));
 subs.push(db.collection("orders").where("buyerId","==",U).limit(200).onSnapshot(mapDocs("ordersB"),E));
 subs.push(db.collection("orders").where("sellerId","==",U).limit(200).onSnapshot(mapDocs("ordersS"),E));
 subs.push(db.collection("notifs").where("toId","==",U).limit(100).onSnapshot(mapDocs("notifs"),E));
 subs.push(db.doc("data/users/"+U+"/me").onSnapshot(function(s){if(s.exists)D.me=Object.assign({favs:[],prefs:[],tcAccepted:false,notifSeen:0},JSON.parse(JSON.stringify(s.data())));refresh()},E));
 setTimeout(function(){if(!D.ready.sellers){D.ready.sellers=1;render()}},6000);
}
boot();
})();

window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();deferredInstall=e});
if("serviceWorker" in navigator)window.addEventListener("load",function(){navigator.serviceWorker.register("sw.js").catch(function(){})});
