import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  mainSidebar: [
    {
      type: "doc",
      id: "index",
      label: "Overview",
    },
    {
      type: "doc",
      id: "cognitive-architecture",
      label: "Cognitive Architecture",
    },
    {
      type: "category",
      label: "Planned Work",
      collapsed: false,
      items: [
        "specs/index",
        "specs/implementation-roadmap",
        "specs/status-dashboard",
        "specs/investigate-first-pipeline",
        "specs/modularization",
        "specs/docker-modular",
        "specs/memory-sync",
        "specs/postgres-multi-schema",
      ],
    },
    {
      type: "category",
      label: "Infrastructure",
      collapsed: false,
      items: [
        "cloudformation/index",
      ],
    },
    {
      type: "category",
      label: "Configuration",
      collapsed: false,
      items: [
        "ansible/index",
      ],
    },
    {
      type: "category",
      label: "Windmill Automation",
      collapsed: false,
      items: [
        "windmill/devops",
        "windmill/investigate",
      ],
    },
    {
      type: "doc",
      id: "architecture",
      label: "Architecture Decisions",
    },
    {
      type: "doc",
      id: "pai-config",
      label: "PAI Configuration",
    },
  ],
};

export default sidebars;
