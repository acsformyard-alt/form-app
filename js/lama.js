// LaMa INT8 inpainting via onnxruntime-web
const results = await session.run(feeds);
const outName = session.outputNames ? session.outputNames[0] : Object.keys(results)[0];
const out = results[outName]; // [1,3,H,W]


// Postprocess back to original aspect
const outCanvas = document.createElement('canvas');
outCanvas.width = srcCanvas.width; outCanvas.height = srcCanvas.height;
const g = outCanvas.getContext('2d');
const outImg = nchwToCanvas(out.data, target, target);
// Remove letterbox
const cropped = invMap(outImg);
g.drawImage(cropped, 0, 0);
return outCanvas;
}


function drawBitmapToCanvas(bmp){
const c = document.createElement('canvas'); c.width=bmp.width; c.height=bmp.height;
c.getContext('2d').drawImage(bmp,0,0); return c;
}


function buildUpperRightMask(canvas, frac){
const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
const g = c.getContext('2d');
g.clearRect(0,0,c.width,c.height);
const rw = Math.round(canvas.width * frac.w);
const rh = Math.round(canvas.height * frac.h);
const rx = canvas.width - rw;
const ry = 0;
g.fillStyle = 'rgba(255,255,255,1)';
g.fillRect(rx, ry, rw, rh);
return c;
}


function letterbox(srcCanvas, W, H){
const srcW = srcCanvas.width, srcH = srcCanvas.height;
const scale = Math.min(W/srcW, H/srcH);
const nw = Math.round(srcW*scale), nh = Math.round(srcH*scale);
const dx = Math.floor((W-nw)/2), dy = Math.floor((H-nh)/2);
const c = document.createElement('canvas'); c.width=W; c.height=H;
const g = c.getContext('2d');
g.fillStyle = '#000'; g.fillRect(0,0,W,H);
g.drawImage(srcCanvas, 0,0, srcW,srcH, dx,dy, nw,nh);
const invMap = (patchCanvas)=>{
// patchCanvas is W×H; we need to crop out the central region and scale back to src
const tmp = document.createElement('canvas'); tmp.width = srcW; tmp.height = srcH;
const tg = tmp.getContext('2d');
const crop = document.createElement('canvas'); crop.width = nw; crop.height = nh;
crop.getContext('2d').drawImage(patchCanvas, dx, dy, nw, nh, 0, 0, nw, nh);
tg.drawImage(crop, 0, 0, nw, nh, 0, 0, srcW, srcH);
return tmp;
};
return { prep: c, invMap };
}


function nchwToCanvas(data, H, W){
// data: Float32Array length 3*H*W in [0,1]
const c = document.createElement('canvas'); c.width=W; c.height=H;
const g = c.getContext('2d');
const img = g.createImageData(W,H);
const plane = H*W;
for(let y=0; y<H; y++){
for(let x=0; x<W; x++){
const o = y*W + x;
const r = Math.min(1, Math.max(0, data[0*plane + o]));
const g1= Math.min(1, Math.max(0, data[1*plane + o]));
const b = Math.min(1, Math.max(0, data[2*plane + o]));
const i = o*4;
img.data[i] = Math.round(r*255);
img.data[i+1] = Math.round(g1*255);
img.data[i+2] = Math.round(b*255);
img.data[i+3] = 255;
}
}
g.putImageData(img,0,0);
return c;
}
