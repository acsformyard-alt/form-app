// Minimal UI glue: reads files, renders tiles, triggers batch inpaint


export function uiInit({ inpaintBatch, statusEl }){
const $files = document.getElementById('fileInput');
const $process = document.getElementById('processBtn');
const $gallery = document.getElementById('gallery');


function addTile(name){
const wrap = document.createElement('div');
wrap.className = 'tile';
const head = document.createElement('header');
head.innerHTML = `<span class="meta">${name}</span>`;
const btn = document.createElement('button');
btn.textContent = 'Download';
head.appendChild(btn);
const canv = document.createElement('canvas');
wrap.appendChild(head); wrap.appendChild(canv);
$gallery.appendChild(wrap);
return { canv, btn, wrap };
}


async function handleProcess(){
const files = $files.files;
if(!files || files.length === 0){ statusEl.textContent = 'Choose images first.'; return; }
statusEl.textContent = `Processing ${files.length}…`;


const bitmaps = [];
for(const f of files){
const url = URL.createObjectURL(f);
const img = new Image(); img.src = url; await img.decode();
const bmp = await createImageBitmap(img);
URL.revokeObjectURL(url);
bitmaps.push({ name: f.name, bmp });
}


const results = await inpaintBatch(bitmaps.map(b=>b.bmp));


// render
$gallery.innerHTML = '';
results.forEach((outCanvas, i) => {
const { canv, btn } = addTile(files[i].name);
canv.width = outCanvas.width; canv.height = outCanvas.height;
canv.getContext('2d').drawImage(outCanvas, 0, 0);
btn.onclick = ()=>{
canv.toBlob(blob => {
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = files[i].name.replace(/\.[^.]+$/, '') + '.clean.png';
a.click();
setTimeout(()=>URL.revokeObjectURL(a.href), 500);
}, 'image/png');
};
});


statusEl.textContent = 'Done.';
}


$process.addEventListener('click', handleProcess);
}
