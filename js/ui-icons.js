/* Visual-only Lucide enhancement. It translates presentation emojis after
 * each render without changing element ids, handlers, data attributes or
 * application state. */
'use strict';
const UIIcons = (() => {
  const icons = {
    '☰':'menu','📊':'chart-no-axes-combined','🏢':'building-2','👥':'users','👤':'user-round','📥':'file-input','🧾':'receipt-text','🗓️':'calendar-days','⚖️':'scale','📄':'file-text','💵':'wallet-cards','🤝':'handshake','🗄️':'archive','📦':'package','📋':'clipboard-list','⚙️':'settings','🚪':'log-out','➕':'plus','🔒':'lock-keyhole','🔓':'lock-keyhole-open','🗑️':'trash-2','✏️':'pencil','♻️':'rotate-ccw','✅':'circle-check','❌':'circle-x','⚠️':'triangle-alert','💾':'save','⬇️':'download','🖨️':'printer','👁️':'eye','⏱️':'timer','ℹ️':'info','↩️':'undo-2','🟢':'circle','🔵':'circle','🟠':'circle','🟣':'circle','⚪':'circle','⚫':'circle','✖':'circle-x','✔':'circle-check'
  };
  const skip = new Set(['SCRIPT','STYLE','TEXTAREA','OPTION']);
  function replace(root = document.body) {
    if (!root || !window.lucide) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes=[]; let node;
    while ((node=walker.nextNode())) if (!skip.has(node.parentElement?.tagName) && !node.parentElement?.closest('[data-lucide]')) nodes.push(node);
    nodes.forEach(text => {
      const value=text.nodeValue; if (!Object.keys(icons).some(char => value.includes(char))) return;
      const fragment=document.createDocumentFragment(); let remaining=value;
      while (remaining.length) {
        const index=[...Object.keys(icons)].map(char=>[remaining.indexOf(char),char]).filter(([i])=>i>=0).sort((a,b)=>a[0]-b[0])[0];
        if (!index) { fragment.append(document.createTextNode(remaining)); break; }
        const [at,char]=index; if (at) fragment.append(document.createTextNode(remaining.slice(0,at)));
        const el=document.createElement('i'); el.setAttribute('data-lucide',icons[char]); el.setAttribute('aria-hidden','true'); el.className=`ui-icon ui-icon-${icons[char]}`;
        fragment.append(el); remaining=remaining.slice(at+char.length);
      }
      text.parentNode.replaceChild(fragment,text);
    });
    window.lucide.createIcons({ attrs: { 'stroke-width': 1.8 } });
  }
  function init() {
    replace();
    let pending=false;
    new MutationObserver(() => { if (!pending) { pending=true; requestAnimationFrame(()=>{ pending=false; replace(); }); } }).observe(document.body,{childList:true,subtree:true});
  }
  return { init, replace };
})();
