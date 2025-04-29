"use client";
import { useEffect, useRef, useState, FormEvent, useCallback } from "react";
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// Define global types for window properties
declare global {
  interface Window {
    __globeWorld: any;
    __three: any;
  }
}

// Add a local module declaration for 'solar-calculator' to suppress type errors
// This is safe for our usage.

declare module 'solar-calculator';

// Add interface for arc data
interface ArcData {
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  name: string;
}

export default function Home() {
  const globeRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [locationInput, setLocationInput] = useState("");
  const [location, setLocation] = useState<{ lat: number; lng: number; name: string } | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const solarRef = useRef<typeof import('solar-calculator')>(null);
  const controlsRef = useRef<OrbitControls | null>(null); // Replace THREE.OrbitControls with imported type
  const lastFrameTimeRef = useRef<number>(Date.now());
  const isUserInteracting = useRef<boolean>(false);
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Create time zone arcs data
  const timeZoneArcs = useRef<ArcData[]>([]);

  // Initialize time zone arcs
  useEffect(() => {
    // Create arcs for each 15° longitude (standard time zone boundaries)
    const arcs: ArcData[] = [];
    for (let lng = -180; lng < 180; lng += 15) {
      // Create finer segments to follow the meridian
      for (let lat = 90; lat > -90; lat -= 2) { // Smaller segments for smoother curve
        arcs.push({
          startLat: lat,
          startLng: lng,
          endLat: Math.max(lat - 2, -90), // Smaller segments
          endLng: lng,
          name: `UTC${lng === 0 ? '' : lng > 0 ? '+' + (lng / 15) : (lng / 15)}`
        });
      }
    }
    timeZoneArcs.current = arcs;
  }, []);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    // Update the time every second
    const interval = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let world: any;
    let isMounted = true;
    const globeDiv = globeRef.current;
    let solarCalc: typeof import('solar-calculator') | null = null;

    // Earth rotation speed: 360 degrees / 24 hours / 60 mins / 60 secs / 1000 ms
    // Multiply by 100 for faster testing speed to test visually
    const degreesPerMillisecond = (360 / (24 * 60 * 60 * 1000));

    // Define interaction handlers outside to ensure correct removal
    const handleInteractionStart = () => {
      isUserInteracting.current = true;
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
    };

    const handleInteractionEnd = () => {
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      interactionTimeoutRef.current = setTimeout(() => {
        isUserInteracting.current = false;
        lastFrameTimeRef.current = Date.now(); // Reset time to prevent jump
      }, 2000);
    };

    async function loadGlobe() {
      const [
        { default: Globe },
        { TextureLoader, ShaderMaterial, Mesh, MeshBasicMaterial, SphereGeometry, MathUtils },
        solar
      ] = await Promise.all([
        import("globe.gl"),
        import("three"),
        import("solar-calculator"),
      ]);
      solarCalc = solar;
      solarRef.current = solar;

      // Day/Night shader - Simplified Fragment Shader
      const dayNightShader = {
        vertexShader: `
          varying vec3 vNormal;
          varying vec2 vUv;
          void main() {
            // Pass texture coordinates
            vUv = uv;
            // Calculate normal in View Space
            vNormal = normalize(normalMatrix * normal);
            // Calculate position in Clip Space
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D dayTexture;
          uniform sampler2D nightTexture;
          varying vec3 vNormal; // Normal in View Space (from vertex shader)
          varying vec2 vUv;     // UV coords (from vertex shader)

          void main() {
            // Define sun direction directly in VIEW SPACE.
            // Example: Sun coming from the right (+X axis). Normalize just in case.
            vec3 sunDirectionViewSpace = normalize(vec3(1.0, 0.0, 0.0));

            // Calculate dot product. Use max to clamp negative values (light only from one side).
            // vNormal is already normalized by the vertex shader.
            float intensity = max(0.0, dot(vNormal, sunDirectionViewSpace));

            // Get base colors from textures
            vec4 dayColor = texture2D(dayTexture, vUv);
            vec4 nightColor = texture2D(nightTexture, vUv);

            // Blend between night and day based on intensity
            // smoothstep creates a smoother transition (terminator)
            // Adjust the edge values (e.g., 0.0, 0.15) to control softness/width of terminator
            float blendFactor = smoothstep(0.0, 0.15, intensity);

            gl_FragColor = mix(nightColor, dayColor, blendFactor);
          }
        `
      };

      // Sun position calculation (Still needed only for declination for camera tilt)
      const getSunDeclination = (dt: number): number => {
        if (!solarCalc) return 0;
        const t = solarCalc.century(dt);
        return solarCalc.declination(t);
      };

      if (globeDiv && isMounted) {
        world = new Globe(globeDiv);
        (window as any).__globeWorld = world;

        const [dayTexture, nightTexture] = await Promise.all([
          new TextureLoader().loadAsync("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-day.jpg"),
          new TextureLoader().loadAsync("https://cdn.jsdelivr.net/npm/three-globe/example/img/earth-night.jpg"),
        ]);

        // Create shader material - remove sunPosition and globeRotation uniforms
        const material = new ShaderMaterial({
          uniforms: {
            dayTexture: { value: dayTexture },
            nightTexture: { value: nightTexture },
            // No sunPosition or globeRotation needed here anymore
          },
          vertexShader: dayNightShader.vertexShader,
          fragmentShader: dayNightShader.fragmentShader
        });

        world
          .globeMaterial(material)
          // No background image for flat black
          .hexBinPointWeight("pop")
          .hexBinMerge(true)
          .enablePointerInteraction(true) // Enable interaction for debugging
          // Add time zone arcs configuration with more visible settings
          .arcsData(timeZoneArcs.current)
          .arcColor(() => '#ffffff') // solid white
          .arcAltitude(0) // No additional altitude
          .arcStroke(0.5) // Thinner lines
          .arcDashLength(1) // Solid lines
          .arcDashGap(0)
          .arcDashAnimateTime(0)
          .arcCurveResolution(180) // Much higher curve resolution
          .arcCircularResolution(16) // Higher circular resolution
          .onArcHover((arc: ArcData | null) => {
            // Add debug logging
            if (arc) {
              console.log('Hovering over arc:', arc);
            }
          })
          // Remove globeRotation update from onZoom (it's not used by shader)
          .onZoom(({ lng, lat }: { lng: number; lat: number }) => {
             console.log('User interaction - Current view position:', { lng, lat });
          });

        // Debug log to verify arc data
        console.log('Time zone arcs data:', timeZoneArcs.current);

        // Set flat black background
        world.renderer().setClearColor(0x000000, 1);

        // Orthographic camera setup (miniature look)
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

        // Calculate initial tilt based on sun declination
        const initialTime = Date.now();
        // Use the new function that only gets declination
        const initialDeclination = getSunDeclination(initialTime);
        const initialTiltRad = MathUtils.degToRad(initialDeclination);

        // Set initial camera 'up' vector based on REAL tilt
        orthoCamera.up.set(Math.sin(-initialTiltRad), Math.cos(-initialTiltRad), 0);
        orthoCamera.lookAt(0, 0, 0);
        world.camera(orthoCamera);

        // Controls
        if (world.controls) {
          const controls = world.controls();
          controlsRef.current = controls; // Store reference
          controls.enableZoom = true;
          controls.enablePan = false;
          controls.enableRotate = true;
          controls.autoRotate = false; // Ensure autoRotate is off

          // Add event listeners using named handlers
          controls.addEventListener('start', handleInteractionStart);
          controls.addEventListener('end', handleInteractionEnd);
        }

        // Animate loop
        lastFrameTimeRef.current = Date.now();
        function animate() {
          if (!isMounted) return;

          const currentTime = Date.now();
          const deltaTime = currentTime - lastFrameTimeRef.current;
          lastFrameTimeRef.current = currentTime;

          if (!world || !solarRef.current) {
            requestAnimationFrame(animate);
            return;
          }

          const cam = world.camera();

          // 1. Get ACTUAL sun declination for camera tilt
          const actualDeclination = getSunDeclination(currentTime);

          // 2. Shader sunPosition/globeRotation not used. No update needed.

          // 3. Update CAMERA tilt based on ACTUAL declination
          const currentTiltRad = MathUtils.degToRad(actualDeclination);
          cam.up.set(Math.sin(-currentTiltRad), Math.cos(-currentTiltRad), 0);

          // 4. Rotate Globe using pointOfView if not interacting
          if (!isUserInteracting.current && deltaTime > 0) {
            const rotationIncrementDegrees = degreesPerMillisecond * deltaTime;
            const currentPov = world.pointOfView();
            let newLng = currentPov.lng - rotationIncrementDegrees;

            while (newLng <= -180) newLng += 360;
            while (newLng > 180) newLng -= 360;

            world.pointOfView({ lat: currentPov.lat, lng: newLng, altitude: currentPov.altitude }, 0);

            // --- REMOVED globeRotation uniform update ---
            // material.uniforms.globeRotation.value.set(newLng, currentPov.lat); // NO LONGER NEEDED
          }

          // 5. Re-apply lookAt
          cam.lookAt(0, 0, 0);

          requestAnimationFrame(animate);
        }
        animate();

        // Store three utilities
        window.__three = { Mesh, MeshBasicMaterial, SphereGeometry };
      }
    }

    loadGlobe();
    return () => {
      isMounted = false;
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      // Clean up controls event listeners using named handlers
      if (controlsRef.current) {
        controlsRef.current.removeEventListener('start', handleInteractionStart);
        controlsRef.current.removeEventListener('end', handleInteractionEnd);
        controlsRef.current.dispose(); // Dispose controls
      }
      if (globeDiv) {
        globeDiv.innerHTML = "";
      }
      window.__globeWorld = undefined;
      window.__three = undefined;
      controlsRef.current = null;
    };
  }, []);

  // Plot marker and rotate globe when location changes
  useEffect(() => {
    if (!location) return;
    const world = window.__globeWorld;
    if (!world) return;

    // Plot the marker using globe.gl's pointsData API
    world
      .pointsData([
        {
          lat: location.lat,
          lng: location.lng,
          name: location.name,
          color: 'yellow',
        },
      ])
      .pointColor('color')
      .pointAltitude(0.02)
      .pointRadius(0.6)
      .pointsMerge(true);

    // Rotate globe to center the location
    world.pointOfView({ lat: location.lat, lng: location.lng, altitude: 2 }, 1000);
  }, [location]);

  // Geocode location input
  const handleLocationSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!locationInput.trim()) return;
    setIsLocating(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(locationInput)}`
      );
      const data = await res.json();
      if (data && data.length > 0) {
        setLocation({
          lat: parseFloat(data[0].lat),
          lng: parseFloat(data[0].lon),
          name: data[0].display_name,
        });
      } else {
        alert("Location not found");
      }
    } catch (err) {
      alert("Error looking up location: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsLocating(false);
    }
  }, [locationInput]);

  return (
    <div style={{ width: "100vw", height: "100vh", margin: 0, overflow: "hidden", position: "relative" }}>
      {/* Top Controls: Time Card + Location Input */}
      <div
        className="top-controls"
        style={{
          position: "absolute",
          top: 24,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.85)",
          color: "lightblue",
          fontFamily: "monospace",
          fontSize: "1.25rem",
          padding: "0.75rem 2rem",
          borderRadius: "1rem",
          zIndex: 10,
          boxShadow: "0 2px 12px #0008",
          display: "flex",
          alignItems: "center",
          gap: "1.5rem"
        }}
      >
        {hasMounted && <span className="time-label">{currentTime.toLocaleString()}</span>}
        <form onSubmit={handleLocationSubmit} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }} className="location-form">
          <input
            type="text"
            value={locationInput}
            onChange={e => setLocationInput(e.target.value)}
            placeholder="Enter a city, address, or lat,lng"
            className="location-input"
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid #333",
              fontSize: "1rem",
              fontFamily: "monospace",
              background: "#111",
              color: "#fff"
            }}
            disabled={isLocating}
          />
          <button
            type="submit"
            className="location-btn"
            style={{
              padding: "0.5rem 1.25rem",
              borderRadius: "0.5rem",
              border: "none",
              background: isLocating ? "#444" : "#1976d2",
              color: "#fff",
              fontWeight: 700,
              fontSize: "1rem",
              cursor: isLocating ? "not-allowed" : "pointer"
            }}
            disabled={isLocating}
          >
            {isLocating ? "Locating..." : "Go"}
          </button>
        </form>
      </div>
      <style jsx>{`
        .top-controls {
          max-width: 95vw;
        }
        @media (max-width: 600px) {
          .top-controls {
            flex-direction: column;
            align-items: stretch;
            gap: 0.75rem;
            padding: 0.75rem 0.5rem;
            font-size: 1rem;
            width: 95vw;
            left: 2.5vw;
            transform: none;
            top: 12px;
            border-radius: 0.75rem;
          }
          .time-label {
            margin-bottom: 0.5rem;
            text-align: center;
            font-size: 1rem;
          }
          .location-form {
            flex-direction: column;
            align-items: stretch;
            gap: 0.5rem;
            width: 100%;
          }
          .location-input {
            width: 100%;
            font-size: 1rem;
            padding: 0.5rem 0.75rem;
          }
          .location-btn {
            width: 100%;
            font-size: 1rem;
            padding: 0.5rem 0;
          }
        }
      `}</style>
      <div ref={globeRef} style={{ width: "100vw", height: "100vh" }} />
    </div>
  );
}
