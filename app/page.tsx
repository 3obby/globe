"use client";
import { useEffect, useRef, useState, FormEvent, useCallback } from "react";

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
  const solarRef = useRef<any>(null); // Ref to store solar calculator instance

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let world: any;
    let isMounted = true;
    const globeDiv = globeRef.current;
    let solarCalc: any = null; // Store solar calculator instance locally

    async function loadGlobe() {
      const [
        { default: Globe },
        { TextureLoader, ShaderMaterial, Vector2, Mesh, MeshBasicMaterial, SphereGeometry, MathUtils }, // Import MathUtils
        solar
      ] = await Promise.all([
        import("globe.gl"),
        import("three"),
        import("solar-calculator"),
      ]);
      solarCalc = solar; // Assign to local variable and ref
      solarRef.current = solar;

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

      // Sun position calculation (returns actual [lng, lat/declination])
      const sunPosAt = (dt: number) => {
        if (!solarCalc) return [0, 0]; // Guard against solarCalc not being loaded
        const day = new Date(dt).setUTCHours(0, 0, 0, 0);
        const t = solarCalc.century(dt);
        const longitude = (day - dt) / 864e5 * 360 - 180;
        // Return REAL longitude and declination
        return [longitude - solarCalc.equationOfTime(t) / 4, solarCalc.declination(t)];
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
          .onZoom(({ lng, lat }: { lng: number; lat: number }) => {
            material.uniforms.globeRotation.value.set(lng, lat);
            // Add debug logging
            console.log('Current view position:', { lng, lat });
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
        const initialDeclination = solarCalc.declination(solarCalc.century(initialTime));
        const initialTiltRad = MathUtils.degToRad(initialDeclination);

        // Set initial camera 'up' vector based on REAL tilt
        orthoCamera.up.set(Math.sin(-initialTiltRad), Math.cos(-initialTiltRad), 0);
        orthoCamera.lookAt(0, 0, 0);
        world.camera(orthoCamera);

        // Controls
        if (world.controls) {
          const controls = world.controls();
          controls.enableZoom = true;
          controls.enablePan = false;
          controls.enableRotate = true;
          // Ensure controls respect the new 'up' direction if possible
          // (globe.gl controls might automatically adapt or might need configuration)
        }

        // Animate day/night cycle and update time/camera tilt
        function animate() {
          if (!isMounted || !solarRef.current || !world) return; // Add checks
          const currentSolar = solarRef.current;
          const dt = Date.now();
          const cam = world.camera();

          // 1. Calculate ACTUAL sun position [lng, lat/declination]
          const [actualLng, actualDeclination] = sunPosAt(dt);

          // 2. Update sunPosition uniform for SHADER: Use actual longitude, but FORCE declination to 0
          material.uniforms.sunPosition.value.set(actualLng, 0);

          // 3. Update CAMERA tilt based on ACTUAL declination
          const currentDeclination = actualDeclination; // Use the real declination here
          const currentTiltRad = MathUtils.degToRad(currentDeclination);
          cam.up.set(Math.sin(-currentTiltRad), Math.cos(-currentTiltRad), 0); // Use negative tilt

          // 4. Re-apply lookAt after changing 'up' to update camera orientation
          cam.lookAt(0, 0, 0);

          requestAnimationFrame(animate);
        }
        animate();

        // Store world for later use
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__globeWorld = world;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__three = { Mesh, MeshBasicMaterial, SphereGeometry };
      }
    }

    loadGlobe();
    return () => {
      isMounted = false;
      if (globeDiv) {
        globeDiv.innerHTML = "";
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__globeWorld = undefined; // Clean up global reference
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__three = undefined;
    };
  }, []); // Keep dependencies empty to run once on mount

  // Plot marker and rotate globe when location changes
  useEffect(() => {
    if (!location) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const world = (window as unknown as { __globeWorld: any }).__globeWorld;
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
