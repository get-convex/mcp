import { defineComponent } from "convex/server";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const component = defineComponent("mcp");
component.use(rateLimiter);

export default component;
