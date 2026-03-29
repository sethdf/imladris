import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Imladris",
  tagline: "Personal cloud workstation — EC2 + Windmill + PAI",
  favicon: undefined,

  url: "https://sethdf.github.io",
  baseUrl: "/imladris/",

  organizationName: "sethdf",
  projectName: "imladris",
  deploymentBranch: "gh-pages",
  trailingSlash: false,

  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  plugins: [
    [
      "docusaurus-plugin-typedoc",
      {
        id: "devops",
        entryPoints: ["../windmill/f/devops"],
        entryPointStrategy: "expand",
        tsconfig: "../tsconfig.json",
        out: "api/devops",
        name: "DevOps Scripts",
        readme: "none",
        skipErrorChecking: true,
        sourceLinkTemplate:
          "https://github.com/sethdf/imladris/blob/main/{path}#L{line}",
      },
    ],
    [
      "docusaurus-plugin-typedoc",
      {
        id: "investigate",
        entryPoints: ["../windmill/f/investigate"],
        entryPointStrategy: "expand",
        tsconfig: "../tsconfig.json",
        out: "api/investigate",
        name: "Investigation Tools",
        readme: "none",
        skipErrorChecking: true,
        sourceLinkTemplate:
          "https://github.com/sethdf/imladris/blob/main/{path}#L{line}",
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/sethdf/imladris/edit/main/docs-site/",
          routeBasePath: "/",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Imladris",
      items: [
        {
          type: "docSidebar",
          sidebarId: "mainSidebar",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://github.com/sethdf/imladris",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Areas",
          items: [
            { label: "CloudFormation", to: "/cloudformation" },
            { label: "Ansible", to: "/ansible" },
            { label: "DevOps Automation", to: "/windmill/devops" },
            { label: "Investigation Tools", to: "/windmill/investigate" },
          ],
        },
        {
          title: "Source",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/sethdf/imladris",
            },
          ],
        },
      ],
      copyright: `Imladris — Built with Docusaurus`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "yaml", "typescript"],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
