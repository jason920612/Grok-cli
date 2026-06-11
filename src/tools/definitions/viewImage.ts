import fs from "node:fs";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

/**
 * view_image — load an image file so the model can SEE it (grok-build-0.1 is
 * multimodal). The image is queued on the context's image mailbox; the agent
 * loop attaches it to the next model turn as an input_image part. Useful for
 * inspecting screenshots, diagrams, mockups, or any PNG/JPG in the workspace.
 */
export function viewImageTool(skills: ToolSkillRegistry) {
  return makeTool(
    "view_image",
    "Load an image file (PNG or JPG) so you can SEE it on your next step. Use to inspect a screenshot, mockup, diagram, or any image in the workspace. Provide a note describing what to look for.",
    schemas.object({ path: { type: "string" }, note: { type: "string" } }, ["path"]),
    z.object({ path: z.string().min(1), note: z.string().optional() }),
    skills,
    async (args, ctx) => {
      if (!/\.(png|jpe?g)$/i.test(args.path)) throw new Error("view_image supports .png/.jpg/.jpeg only");
      const abs = ctx.sandbox.assertReadableFile(args.path);
      const buf = fs.readFileSync(abs);
      if (buf.length > 20_000_000) throw new Error("Image exceeds the 20MB limit for model input.");
      const mime = /\.png$/i.test(args.path) ? "image/png" : "image/jpeg";
      ctx.images?.push({ dataUri: `data:${mime};base64,${buf.toString("base64")}`, note: args.note ?? args.path });
      return { viewed: args.path, bytes: buf.length, attached: Boolean(ctx.images) };
    }
  );
}
