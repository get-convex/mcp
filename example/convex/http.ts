import { httpRouter } from "convex/server";
import { auth } from "./auth.js";
import { mcp } from "./mcp.js";

const http = httpRouter();
auth.addHttpRoutes(http);
mcp.registerRoutes(http);

export default http;
