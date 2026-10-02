/* ════════════════════════════════════════════════════════════════
   REVESSENT · GLASS KIT — runtime companion to glass-kit.css.

   1. Builds the chromatic-displacement SVG filter (the liquid-glass
      card) once per page: a procedurally generated displacement map
      (smooth multi-octave field drawn to a canvas — R encodes x
      shift, G encodes y shift) feeding three feDisplacementMap
      passes — one per colour channel, slightly different scales —
      blended back together, then softened. Same pipeline as the
      reference filter, zero bytes of base64 shipped.
   2. Feature-detects backdrop-filter: url(#…) support and upgrades
      [data-liquidglass] surfaces with .lg-chroma. The CSS keeps a
      plain frost fallback first, so browsers that can't render the
      reference keep the blurred-glass look instead of losing it.
   3. That's all — pills and switches are pure CSS.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function makeDisplacementMap() {
    try {
      var size = 128;
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      var ctx = canvas.getContext('2d');
      if (!ctx) return null;
      var img = ctx.createImageData(size, size);
      var d = img.data;
      for (var y = 0; y < size; y++) {
        for (var x = 0; x < size; x++) {
          var u = x / size * Math.PI * 2;
          var v = y / size * Math.PI * 2;
          var rx = Math.sin(u + 1.3) * Math.cos(v * 1.5) + 0.5 * Math.sin(u * 2 + v);
          var ry = Math.cos(u * 1.5 + 0.7) * Math.sin(v) + 0.5 * Math.cos(u - v * 2);
          var i = (y * size + x) * 4;
          d[i] = 128 + rx * 72;
          d[i + 1] = 128 + ry * 72;
          d[i + 2] = 128;
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (_) {
      return null;
    }
  }

  function injectFilter() {
    if (document.getElementById('gk-glass-filter')) return true;
    var map = makeDisplacementMap();
    if (!map) return false;
    var wrap = document.createElement('div');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    wrap.innerHTML =
      '<svg class="gk-filter-def" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<filter id="gk-glass-filter" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">' +
      '<feImage x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="map" href="' + map + '"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" result="dispRed" scale="-20" xChannelSelector="R" yChannelSelector="G"/>' +
      '<feColorMatrix in="dispRed" type="matrix" values="1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0" result="red"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" result="dispGreen" scale="-24" xChannelSelector="R" yChannelSelector="G"/>' +
      '<feColorMatrix in="dispGreen" type="matrix" values="0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0" result="green"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="map" result="dispBlue" scale="-28" xChannelSelector="R" yChannelSelector="G"/>' +
      '<feColorMatrix in="dispBlue" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0" result="blue"/>' +
      '<feBlend in="red" in2="green" mode="screen" result="rg"/>' +
      '<feBlend in="rg" in2="blue" mode="screen" result="output"/>' +
      '<feGaussianBlur in="output" stdDeviation="3"/>' +
      '</filter>' +
      '</defs>' +
      '</svg>';
    document.body.appendChild(wrap);
    return true;
  }

  function supportsFilterReference() {
    try {
      if (window.CSS && CSS.supports) {
        return CSS.supports('backdrop-filter', 'url(#gk-glass-filter)') ||
               CSS.supports('-webkit-backdrop-filter', 'url(#gk-glass-filter)');
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function upgrade() {
    if (!injectFilter()) return;
    if (!supportsFilterReference()) return;
    document.documentElement.style.setProperty('--gk-filter', 'url(#gk-glass-filter)');
    var surfaces = document.querySelectorAll('[data-liquidglass]');
    for (var i = 0; i < surfaces.length; i++) surfaces[i].classList.add('lg-chroma');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', upgrade);
  } else {
    upgrade();
  }
})();
