/**
 * 浏览器快路径用的**页内表达式**。
 *
 * 这些字符串与工具箱 `toolkit/win/web.cs` 里对应的表达式**逐字对齐**（`TextExpr` / `Value` / `Els`），
 * 只额外带一个 `wall` 字段——快路径复用工具箱自己的 `web-lib.js`，不是另写一套语义。
 *
 * 单独成文件的原因：这里只依赖类型，没有 DSH 依赖，所以既能被工具层引用，也能被
 * `scripts/bench.mjs` 直接导入做性能对照。
 *
 * @module dsh-computer-use/webexpr
 */
/** 页内 wall 片段：与工具箱 `AddWall` 同源，就是 `__cu.wall()`。 */
export const WALL_FRAG = "wall:String((window.__cu&&__cu.wall&&__cu.wall())||'')";
/**
 * 读页面文字（对齐 `web.cs` 的 `TextExpr`）。
 * @param sel - 作用域选择器；空串表示整个 body。
 * @param max - 截断上限；<=0 用 20000（与工具箱一致）。
 */
export function textExpr(sel, max) {
    const cap = max > 0 ? max : 20_000;
    const target = sel.length === 0 ? 'document.body' : `document.querySelector(${JSON.stringify(sel)})`;
    const missing = sel.length === 0
        ? "'document has no body yet (still loading?)'"
        : `'selector not found: '+${JSON.stringify(sel)}`;
    return (`(()=>{try{var el=${target};` +
        `if(!el)return{ok:false,err:'ERR_NOT_FOUND',msg:${missing}};` +
        `var t=el.innerText||el.textContent||'';var tr=false;var full=t.length;` +
        `if(t.length>${cap}){t=t.slice(0,${cap});tr=true;}` +
        `return{ok:true,url:String(location.href),title:String(document.title),text:t,len:full,chars:t.length,truncated:tr,${WALL_FRAG}};` +
        `}catch(e){return{ok:false,err:'ERR_SEL',msg:String(e.message)}}})()`);
}
/** 读输入框/富文本当前值（对齐 `web.cs` 的 `Value`：无选择器时读当前焦点元素）。 */
export function valueExpr(sel) {
    if (sel.length === 0) {
        return ('(function(){var el=document.activeElement||document.body;' +
            `return{ok:true,value:__cu.readValue(el),${WALL_FRAG}};})()`);
    }
    const q = `{sel:${JSON.stringify(sel)},text:"",index:1,exact:false,id:0,raw:true}`;
    return (`(function(){var L=__cu.locate(${q});if(!L.ok)return L;` +
        `return{ok:true,value:__cu.readValue(L.el),${WALL_FRAG}};})()`);
}
/** 列可交互元素（对齐 `web.cs` 的 `Els`，含"视口优先 + total"的本地改进）。 */
export function elsExpr(sel, all, max) {
    return (`(function(){var l=__cu.collect(${JSON.stringify(sel)},${all ? 'true' : 'false'},${max},false);` +
        `if(!l)return{ok:false,err:'ERR_NOT_FOUND',msg:'scope selector not found: '+${JSON.stringify(sel)}};` +
        `return{ok:true,count:l.length,total:(__cu.elsTotal||l.length),url:String(location.href),elements:l,${WALL_FRAG}};})()`);
}
