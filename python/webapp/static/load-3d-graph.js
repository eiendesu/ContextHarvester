/* Bootstrap: load Three.js module, expose global THREE, then load 3d-force-graph */
import * as THREE from '/vendor/force-graph/three.module.min.js';
window.THREE = THREE;

await new Promise((resolve, reject) => {
  const script = document.createElement('script');
  script.src = '/vendor/force-graph/3d-force-graph.min.js';
  script.onload = resolve;
  script.onerror = () => reject(new Error('Failed to load 3d-force-graph'));
  document.head.appendChild(script);
});
