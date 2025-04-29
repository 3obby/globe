"use client";
import { useEffect, useRef } from "react";

// Define the Globe.gl instance type as any
declare global {
  interface Window {
    __globeWorld: any;
  }
}

interface Location {
  lat: number;
  lng: number;
  name: string;
}

interface GlobeViewProps {
  location: Location | null;
  style?: React.CSSProperties;
}

export default function GlobeView({ location, style }: GlobeViewProps) {
  const globeRef = useRef<HTMLDivElement>(null);

  // Responsive: update globe size on container resize
  useEffect(() => {
    const globeDiv = globeRef.current;
    if (!globeDiv) return;
    
    const world: any = window.__globeWorld;
    let resizeObserver: ResizeObserver | null = null;
    if (world && world.renderer && world.camera) {
      resizeObserver = new ResizeObserver(() => {
        const width = globeDiv.offsetWidth;
        const height = globeDiv.offsetHeight;
        world.renderer().setSize(width, height, false); // false = don't update style, just buffer

        // Dynamically calculate d so the globe always fits
        const d = Math.min(width, height) / 2.1; // 2.1 gives a little margin

        if (world.camera().isOrthographicCamera) {
          const aspect = width / height;
          world.camera().left = -d * aspect;
          world.camera().right = d * aspect;
          world.camera().top = d;
          world.camera().bottom = -d;
          world.camera().position.set(0, 0, 400);
          world.camera().lookAt(0, 0, 0);
          world.camera().updateProjectionMatrix();
        } else if (world.camera().isPerspectiveCamera) {
          world.camera().aspect = width / height;
          world.camera().updateProjectionMatrix();
        }
      });
      resizeObserver.observe(globeDiv);
    }
    return () => {
      if (resizeObserver && globeDiv) resizeObserver.unobserve(globeDiv);
    };
  }, []);

  useEffect(() => {
    let world: any;
    let isMounted = true;
    const globeDiv = globeRef.current;

    async function loadGlobe() {
      const [
        { default: Globe },
        { TextureLoader, ShaderMaterial, Vector2 },
        solar
      ] = await Promise.all([
        import("globe.gl"),
        import("three"),
        import("solar-calculator"),
      ]);

      // Day/Night shader
      const dayNightShader = {
        vertexShader: `
          varying vec3 vNormal;
          varying vec2 vUv;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          #define PI 3.141592653589793
          uniform sampler2D dayTexture;
          uniform sampler2D nightTexture;
          uniform vec2 sunPosition;
          uniform vec2 globeRotation;
          varying vec3 vNormal;
          varying vec2 vUv;

          float toRad(in float a) {
            return a * PI / 180.0;
          }

          vec3 Polar2Cartesian(in vec2 c) { // [lng, lat]
            float theta = toRad(90.0 - c.x);
            float phi = toRad(90.0 - c.y);
            return vec3(
              sin(phi) * cos(theta),
              cos(phi),
              sin(phi) * sin(theta)
            );
          }

          void main() {
            float invLon = toRad(globeRotation.x);
            float invLat = -toRad(globeRotation.y);
            mat3 rotX = mat3(
              1, 0, 0,
              0, cos(invLat), -sin(invLat),
              0, sin(invLat), cos(invLat)
            );
            mat3 rotY = mat3(
              cos(invLon), 0, sin(invLon),
              0, 1, 0,
              -sin(invLon), 0, cos(invLon)
            );
            vec3 rotatedSunDirection = rotX * rotY * Polar2Cartesian(sunPosition);
            float intensity = dot(normalize(vNormal), normalize(rotatedSunDirection));
            vec4 dayColor = texture2D(dayTexture, vUv);
            vec4 nightColor = texture2D(nightTexture, vUv);
            float blendFactor = smoothstep(-0.1, 0.1, intensity);
            gl_FragColor = mix(nightColor, dayColor, blendFactor);
          }
        `
      };

      // Sun position calculation
      const sunPosAt = (dt: number) => {
        const day = new Date(dt).setUTCHours(0, 0, 0, 0);
        const t = solar.century(dt);
        const longitude = (day - dt) / 864e5 * 360 - 180;
        return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)];
      };

      if (globeDiv && isMounted) {
        world = new Globe(globeDiv);

        // Load day and night textures
        const [dayTexture, nightTexture] = await Promise.all([
          new TextureLoader().loadAsync("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-day.jpg"),
          new TextureLoader().loadAsync("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg"),
        ]);

        // Create shader material
        const material = new ShaderMaterial({
          uniforms: {
            dayTexture: { value: dayTexture },
            nightTexture: { value: nightTexture },
            sunPosition: { value: new Vector2() },
            globeRotation: { value: new Vector2() }
          },
          vertexShader: dayNightShader.vertexShader,
          fragmentShader: dayNightShader.fragmentShader
        });

        world
          .globeMaterial(material)
          .hexBinPointWeight("pop")
          .hexBinMerge(true)
          .enablePointerInteraction(false)
          .onZoom(({ lng, lat }: { lng: number; lat: number }) => {
            material.uniforms.globeRotation.value.set(lng, lat);
          });

        world.renderer().setClearColor(0x000000, 1);

        // Orthographic camera setup
        const width = globeDiv.offsetWidth;
        const height = globeDiv.offsetHeight;
        const aspect = width / height;
        const d = 250;
        const orthoCamera = new (await import("three")).OrthographicCamera(
          -d * aspect,
          d * aspect,
          d,
          -d,
          0.1,
          2000
        );
        orthoCamera.position.set(0, 0, 400);
        orthoCamera.lookAt(0, 0, 0);
        world.camera(orthoCamera);

        if (world.controls) {
          const controls = world.controls();
          controls.enableZoom = true;
          controls.enablePan = false;
          controls.enableRotate = true;
        }

        // Animate day/night cycle
        function animate() {
          if (!isMounted) return;
          const dt = Date.now();
          const [lng, lat] = sunPosAt(dt);
          material.uniforms.sunPosition.value.set(lng, lat);
          requestAnimationFrame(animate);
        }
        animate();

        // Store world for later use
        window.__globeWorld = world;
      }
    }

    loadGlobe();
    return () => {
      isMounted = false;
      if (globeDiv) {
        globeDiv.innerHTML = "";
      }
    };
  }, []);

  // Plot marker and rotate globe when location changes
  useEffect(() => {
    if (!location) return;
    const world = window.__globeWorld;
    if (!world) return;

    world
      .pointsData([
        {
          lat: location.lat,
          lng: location.lng,
          name: location.name,
          color: 'red',
        },
      ])
      .pointColor('color')
      .pointAltitude(0.02)
      .pointRadius(0.6)
      .pointsMerge(true);

    world.pointOfView({ lat: location.lat, lng: location.lng, altitude: 2 }, 1000);
  }, [location]);

  return (
    <div
      ref={globeRef}
      className="globe-container"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        ...style,
      }}
    />
  );
} 