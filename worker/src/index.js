// Entrada para Cloudflare Workers. La logica vive en handler.js, compartida
// con el servidor local de pruebas.
import html from "../../app/lector.html";
import { handle } from "./handler.js";

export default {
  fetch(request, env) {
    return handle(request, env, html);
  }
};
