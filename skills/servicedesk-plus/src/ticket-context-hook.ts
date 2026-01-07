/**
 * Ticket Context Hook
 *
 * Automatically loads ticket context when working in a ticket directory.
 * Triggered on SessionStart to inject relevant ticket information.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface TicketMetadata {
  id: string;
  subject: string;
  description: string;
  priority: { name: string };
  status: { name: string };
  created_time: { display_value: string };
  due_by_time: { display_value: string };
}

interface HookInput {
  session_id: string;
  cwd: string;
}

interface HookOutput {
  continue: boolean;
  context?: string;
}

const TICKETS_DIR = path.join(os.homedir(), "work", "tickets");

/**
 * Check if current directory is a ticket directory
 */
function isTicketDirectory(cwd: string): boolean {
  // Check if we're in ~/work/tickets/SDP-* or a subdirectory
  if (!cwd.startsWith(TICKETS_DIR)) {
    return false;
  }

  // Look for .ticket.json in current dir or parent
  const ticketFile = findTicketFile(cwd);
  return ticketFile !== null;
}

/**
 * Find .ticket.json file in directory or parents (up to TICKETS_DIR)
 */
function findTicketFile(dir: string): string | null {
  let current = dir;

  while (current.startsWith(TICKETS_DIR) && current.length >= TICKETS_DIR.length) {
    const ticketPath = path.join(current, ".ticket.json");
    if (fs.existsSync(ticketPath)) {
      return ticketPath;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Load ticket metadata from .ticket.json
 */
function loadTicketMetadata(ticketFile: string): TicketMetadata | null {
  try {
    const content = fs.readFileSync(ticketFile, "utf-8");
    const data = JSON.parse(content);
    return data.request || data;
  } catch {
    return null;
  }
}

/**
 * Load notes.md if it exists
 */
function loadNotes(ticketDir: string): string | null {
  const notesPath = path.join(ticketDir, "notes.md");
  if (fs.existsSync(notesPath)) {
    try {
      return fs.readFileSync(notesPath, "utf-8");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Generate context string for the ticket
 */
function generateContext(ticket: TicketMetadata, notes: string | null): string {
  let context = `
## Current Ticket Context

**Ticket**: SDP-${ticket.id}
**Subject**: ${ticket.subject}
**Status**: ${ticket.status?.name || "Unknown"}
**Priority**: ${ticket.priority?.name || "Unknown"}

### Description
${ticket.description || "No description provided"}

### Key Information
- Created: ${ticket.created_time?.display_value || "Unknown"}
- Due: ${ticket.due_by_time?.display_value || "Not set"}
`;

  if (notes) {
    context += `
### Previous Notes
${notes.slice(0, 2000)}${notes.length > 2000 ? "\n...(truncated)" : ""}
`;
  }

  context += `
### Available Commands
- "update ticket: <message>" - Add note to ticket
- "set status to <status>" - Change ticket status
- "show ticket" - Display full ticket details
- "done with ticket" - End session and summarize
`;

  return context;
}

/**
 * Main hook handler
 */
export async function onSessionStart(input: HookInput): Promise<HookOutput> {
  const { cwd } = input;

  // Check if we're in a ticket directory
  if (!isTicketDirectory(cwd)) {
    return { continue: true };
  }

  // Find and load ticket metadata
  const ticketFile = findTicketFile(cwd);
  if (!ticketFile) {
    return { continue: true };
  }

  const ticket = loadTicketMetadata(ticketFile);
  if (!ticket) {
    return { continue: true };
  }

  // Load notes if available
  const ticketDir = path.dirname(ticketFile);
  const notes = loadNotes(ticketDir);

  // Generate and return context
  const context = generateContext(ticket, notes);

  return {
    continue: true,
    context: context,
  };
}

// For CLI testing
if (require.main === module) {
  const testInput: HookInput = {
    session_id: "test",
    cwd: process.cwd(),
  };

  onSessionStart(testInput).then((result) => {
    if (result.context) {
      console.log("Ticket context loaded:");
      console.log(result.context);
    } else {
      console.log("No ticket context (not in ticket directory)");
    }
  });
}
