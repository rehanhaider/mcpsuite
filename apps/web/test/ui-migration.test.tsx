import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { badgeVariants } from "../src/components/ui/badge.tsx";
import { buttonVariants } from "../src/components/ui/button.tsx";
import { NativeSelect } from "../src/components/ui/native-select.tsx";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(webRoot, "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("shadcn migration boundaries", () => {
  it("keeps Base UI imports inside generated shadcn sources", () => {
    const violations = sourceFiles(sourceRoot)
      .filter(
        (path) => !relative(sourceRoot, path).startsWith("components/ui/"),
      )
      .filter((path) => readFileSync(path, "utf8").includes("@base-ui/react"))
      .map((path) => relative(sourceRoot, path));

    expect(violations).toEqual([]);
  });

  it("uses shared shadcn primitives for application controls", () => {
    const violations = sourceFiles(sourceRoot)
      .filter(
        (path) => !relative(sourceRoot, path).startsWith("components/ui/"),
      )
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return /<(button|input|select|textarea|dialog)\b/.test(source)
          ? [relative(sourceRoot, path)]
          : [];
      });

    expect(violations).toEqual([]);
  });

  it("uses the official Base UI shadcn configuration", () => {
    const config = JSON.parse(
      readFileSync(join(webRoot, "components.json"), "utf8"),
    ) as {
      style: string;
      aliases: { ui: string };
    };

    expect(config.style).toBe("base-nova");
    expect(config.aliases.ui).toBe("~/components/ui");
  });

  it("preserves compact product control sizes", () => {
    expect(buttonVariants({ size: "default" })).toContain("h-8");
    expect(buttonVariants({ size: "lg" })).toContain("h-9");
    expect(buttonVariants({ size: "cta" })).toContain("h-10");
    expect(buttonVariants({ size: "cta-lg" })).toContain("h-12");
    expect(badgeVariants({ size: "xs" })).toContain("h-4");

    const nativeSelect = renderToStaticMarkup(
      <NativeSelect size="xs" defaultValue="active">
        <option value="active">Active</option>
      </NativeSelect>,
    );
    expect(nativeSelect).toContain('data-size="xs"');
    expect(nativeSelect).toContain("h-6");
  });

  it("keeps product composites outside the generated primitive library", () => {
    const dialogSource = readFileSync(
      join(sourceRoot, "components/ui/dialog.tsx"),
      "utf8",
    );
    const compositeSource = readFileSync(
      join(sourceRoot, "components/ui.tsx"),
      "utf8",
    );

    expect(dialogSource).not.toContain("function Modal");
    expect(compositeSource).toContain("export function Modal");
  });

  it("installs the complete mapped primitive set and removes legacy duplicates", () => {
    const files = [
      "badge",
      "button",
      "checkbox",
      "dialog",
      "dropdown-menu",
      "input",
      "kbd",
      "native-select",
      "popover",
      "separator",
      "sheet",
      "sidebar",
      "skeleton",
      "sonner",
      "switch",
      "textarea",
      "tooltip",
    ];

    for (const file of files) {
      expect(existsSync(join(sourceRoot, `components/ui/${file}.tsx`))).toBe(
        true,
      );
    }
    expect(existsSync(join(sourceRoot, "components/ui/select.tsx"))).toBe(
      false,
    );
    expect(existsSync(join(sourceRoot, "components/Toasts.tsx"))).toBe(false);
  });

  it("preserves emcp theme tokens after shadcn initialization", () => {
    const css = readFileSync(join(sourceRoot, "styles/app.css"), "utf8");

    expect(css).toContain("--primary: #c81e78");
    expect(css).toContain("--background: #fbfbfc");
    expect(css).toContain("--background: #131316");
    expect(css).toContain('@import "shadcn/tailwind.css"');
    expect(css).not.toContain("@utility checkbox");
  });
});
