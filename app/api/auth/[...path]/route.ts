import { neonAuth } from "@/lib/auth/neon-server";

export const { GET, POST, PUT, PATCH, DELETE } = neonAuth.handler();
