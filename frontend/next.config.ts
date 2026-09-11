import type { NextConfig } from "next";

// El navegador habla solo con Next; Next reenvia /api/* al backend FastAPI.
// Asi no hace falta CORS y la direccion del backend no queda en el cliente.
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // Servidor autonomo en .next/standalone: la imagen de Docker no necesita node_modules.
  output: "standalone",
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
  },
};

export default nextConfig;
