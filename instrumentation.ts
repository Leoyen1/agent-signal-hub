import { validateProductionRuntimeConfig } from "@/lib/runtime-config";
export async function register() { validateProductionRuntimeConfig(); }