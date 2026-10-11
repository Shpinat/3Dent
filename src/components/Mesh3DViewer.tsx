import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

interface Props {
  file: File;
}

export function Mesh3DViewer({ file }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 0, 200);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1).normalize();
    scene.add(directionalLight);

    const loadMesh = async () => {
      const url = URL.createObjectURL(file);
      const ext = file.name.split('.').pop()?.toLowerCase();

      const material = new THREE.MeshPhongMaterial({ color: 0xcccccc, specular: 0x111111, shininess: 50 });
      let mesh: THREE.Object3D | null = null;

      try {
        if (ext === 'stl') {
          const loader = new STLLoader();
          const geometry = await loader.loadAsync(url);
          geometry.center();
          mesh = new THREE.Mesh(geometry, material);
        } else if (ext === 'obj') {
          const loader = new OBJLoader();
          const object = await loader.loadAsync(url);
          // Center OBJ
          const box = new THREE.Box3().setFromObject(object);
          const center = box.getCenter(new THREE.Vector3());
          object.position.sub(center);
          mesh = object;
        } else if (ext === 'ply') {
          const loader = new PLYLoader();
          const geometry = await loader.loadAsync(url);
          geometry.center();
          geometry.computeVertexNormals();

          if (geometry.hasAttribute('color')) {
            material.vertexColors = true;
          }
          mesh = new THREE.Mesh(geometry, material);
        }

        if (mesh) {
          scene.add(mesh);

          // Auto-adjust camera
          const box = new THREE.Box3().setFromObject(mesh);
          const size = box.getSize(new THREE.Vector3()).length();
          const center = box.getCenter(new THREE.Vector3());

          controls.target.copy(center);
          camera.position.copy(center);
          camera.position.z += size;
          camera.near = size / 100;
          camera.far = size * 100;
          camera.updateProjectionMatrix();
        }
      } catch (err) {
        console.error('Failed to load 3D mesh:', err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };

    void loadMesh();

    const animate = () => {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      if (!container) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [file]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
