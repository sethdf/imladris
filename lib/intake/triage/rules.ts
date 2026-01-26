/**
 * Rules Engine
 *
 * Deterministic classification using json-rules-engine.
 * Handles obvious cases without AI.
 */

import { Engine, Rule } from "json-rules-engine";
import { isVip } from "../db/database.js";

// =============================================================================
// Types
// =============================================================================

export interface TriageInput {
  id: string;
  zone: string;
  source: string;
  type: string;
  subject?: string;
  body?: string;
  from_name?: string;
  from_address?: string;
  participants?: string[];
  created_at?: Date;
  entities?: ExtractedEntities;
}

export interface TriageOutput {
  category?: string;
  priority?: string;
  quick_win?: boolean;
  quick_win_reason?: string;
  estimated_time?: string;
  reasoning?: string;
  suggested_action?: string;
  confidence: number;
  triaged_by: "rules";
}

export interface ExtractedEntities {
  dates: string[];
  times: string[];
  people: string[];
  organizations: string[];
  urgency_cues: string[];
}

// =============================================================================
// Default Rules
// =============================================================================

const defaultRules: Rule[] = [
  // VIP sender - always high priority
  new Rule({
    name: "vip-sender",
    conditions: {
      all: [
        {
          fact: "is_vip",
          operator: "equal",
          value: true,
        },
      ],
    },
    event: {
      type: "set-priority",
      params: {
        priority: "P1",
        category: "Action-Required",
        reasoning: "Message from VIP contact",
        confidence: 9,
      },
    },
    priority: 100,
  }),

  // Urgent keywords
  new Rule({
    name: "urgent-keywords",
    conditions: {
      any: [
        {
          fact: "has_urgent_keywords",
          operator: "equal",
          value: true,
        },
      ],
    },
    event: {
      type: "set-priority",
      params: {
        priority: "P1",
        category: "Action-Required",
        reasoning: "Contains urgent keywords",
        confidence: 7,
      },
    },
    priority: 90,
  }),

  // Quick win - short messages asking simple questions
  new Rule({
    name: "quick-question",
    conditions: {
      all: [
        {
          fact: "body_length",
          operator: "lessThan",
          value: 200,
        },
        {
          fact: "contains_question",
          operator: "equal",
          value: true,
        },
      ],
    },
    event: {
      type: "set-quick-win",
      params: {
        quick_win: true,
        quick_win_reason: "Short question - can answer quickly",
        estimated_time: "5min",
        confidence: 6,
      },
    },
    priority: 50,
  }),

  // FYI - newsletters, notifications
  new Rule({
    name: "newsletter",
    conditions: {
      any: [
        {
          fact: "is_newsletter",
          operator: "equal",
          value: true,
        },
        {
          fact: "is_notification",
          operator: "equal",
          value: true,
        },
      ],
    },
    event: {
      type: "set-category",
      params: {
        category: "FYI",
        priority: "P3",
        reasoning: "Newsletter or notification",
        confidence: 8,
      },
    },
    priority: 40,
  }),
];

// =============================================================================
// Engine Setup
// =============================================================================

export function createTriageEngine(customRules?: Rule[]): Engine {
  const engine = new Engine();

  // Add custom facts
  engine.addFact("is_vip", async (params, almanac) => {
    const email = await almanac.factValue("from_address");
    return isVip(email as string);
  });

  engine.addFact("has_urgent_keywords", async (_params, almanac) => {
    const subject = (await almanac.factValue("subject")) as string || "";
    const body = (await almanac.factValue("body")) as string || "";
    const text = `${subject} ${body}`.toLowerCase();

    const urgentKeywords = [
      "urgent",
      "asap",
      "immediately",
      "emergency",
      "critical",
      "deadline",
      "today",
      "eod",
      "end of day",
    ];

    return urgentKeywords.some((k) => text.includes(k));
  });

  engine.addFact("body_length", async (_params, almanac) => {
    const body = (await almanac.factValue("body")) as string || "";
    return body.length;
  });

  engine.addFact("contains_question", async (_params, almanac) => {
    const body = (await almanac.factValue("body")) as string || "";
    return body.includes("?");
  });

  engine.addFact("is_newsletter", async (_params, almanac) => {
    const from = (await almanac.factValue("from_address")) as string || "";
    const subject = (await almanac.factValue("subject")) as string || "";

    const newsletterPatterns = [
      /noreply@/i,
      /newsletter@/i,
      /digest@/i,
      /weekly@/i,
      /daily@/i,
      /unsubscribe/i,
    ];

    return newsletterPatterns.some((p) => p.test(from) || p.test(subject));
  });

  engine.addFact("is_notification", async (_params, almanac) => {
    const from = (await almanac.factValue("from_address")) as string || "";
    const subject = (await almanac.factValue("subject")) as string || "";
    const text = `${from} ${subject}`.toLowerCase();

    const notificationPatterns = [
      "notification",
      "alert",
      "reminder",
      "automated",
      "do not reply",
    ];

    return notificationPatterns.some((p) => text.includes(p));
  });

  // Add rules
  const rules = customRules || defaultRules;
  rules.forEach((rule) => engine.addRule(rule));

  return engine;
}

// =============================================================================
// Triage Execution
// =============================================================================

export async function triageWithRules(input: TriageInput): Promise<TriageOutput | null> {
  const engine = createTriageEngine();

  const results = await engine.run({
    id: input.id,
    zone: input.zone,
    source: input.source,
    type: input.type,
    subject: input.subject,
    body: input.body,
    from_name: input.from_name,
    from_address: input.from_address,
    participants: input.participants,
    created_at: input.created_at,
  });

  if (results.events.length === 0) {
    return null; // No rules matched - needs AI triage
  }

  // Combine all event results
  const output: TriageOutput = {
    confidence: 0,
    triaged_by: "rules",
  };

  for (const event of results.events) {
    const params = event.params as Record<string, unknown>;

    if (params.category) output.category = params.category as string;
    if (params.priority) output.priority = params.priority as string;
    if (params.quick_win) output.quick_win = params.quick_win as boolean;
    if (params.quick_win_reason) output.quick_win_reason = params.quick_win_reason as string;
    if (params.estimated_time) output.estimated_time = params.estimated_time as string;
    if (params.reasoning) {
      output.reasoning = output.reasoning
        ? `${output.reasoning}; ${params.reasoning}`
        : (params.reasoning as string);
    }
    if ((params.confidence as number) > output.confidence) {
      output.confidence = params.confidence as number;
    }
  }

  return output;
}
