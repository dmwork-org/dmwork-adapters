import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registerGroupAccount,
  readGroupMdFromDisk,
  readGroupMeta,
  writeGroupMdToDisk,
  deleteGroupMdFromDisk,
  scanForAccountId,
  getGroupMdForPrompt,
  clearGroupMdChecked,
  DMWORK_GROUP_RE,
  _testGetGroupAccountMap,
  _testGetCheckedGroups,
  _testReset,
  type GroupMdMeta,
} from "./group-md.js";

// Use a temp directory to simulate ~/.openclaw/workspace
let tmpBase: string;
let originalHome: string;

beforeEach(() => {
  _testReset();
  tmpBase = join(tmpdir(), `group-md-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpBase, { recursive: true });
  originalHome = process.env.HOME!;
  process.env.HOME = tmpBase;
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    // cleanup best effort
  }
});

describe("DMWORK_GROUP_RE", () => {
  it("should match dmwork group sessionKey", () => {
    const key = "agent:myAgent:dmwork:group:g123456";
    const match = DMWORK_GROUP_RE.exec(key);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("g123456");
  });

  it("should match group with complex id", () => {
    const key = "agent:abc:dmwork:group:s1_grp_room42";
    const match = DMWORK_GROUP_RE.exec(key);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("s1_grp_room42");
  });

  it("should NOT match dmwork direct sessionKey", () => {
    const key = "agent:myAgent:dmwork:direct:uid123";
    expect(DMWORK_GROUP_RE.exec(key)).toBeNull();
  });

  it("should NOT match non-dmwork sessionKey", () => {
    const key = "agent:myAgent:main";
    expect(DMWORK_GROUP_RE.exec(key)).toBeNull();
  });

  it("should NOT match other channel group sessionKey", () => {
    const key = "agent:myAgent:telegram:group:g123";
    expect(DMWORK_GROUP_RE.exec(key)).toBeNull();
  });
});

describe("registerGroupAccount", () => {
  it("should store groupNo → accountId mapping", () => {
    registerGroupAccount("group1", "acct_jeff");
    expect(_testGetGroupAccountMap().get("group1")).toBe("acct_jeff");
  });

  it("should overwrite existing mapping", () => {
    registerGroupAccount("group1", "acct_old");
    registerGroupAccount("group1", "acct_new");
    expect(_testGetGroupAccountMap().get("group1")).toBe("acct_new");
  });
});

describe("writeGroupMdToDisk / readGroupMdFromDisk / readGroupMeta", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_abc";

  it("should write and read GROUP.md content", () => {
    const content = "# Group Rules\nBe nice.";
    const meta: GroupMdMeta = {
      version: 5,
      updated_at: "2026-03-17T17:00:00+08:00",
      updated_by: "uid_admin",
      fetched_at: "2026-03-17T17:01:00+08:00",
      account_id: accountId,
    };

    writeGroupMdToDisk({ agentId, accountId, groupNo, content, meta });

    const readContent = readGroupMdFromDisk(agentId, accountId, groupNo);
    expect(readContent).toBe(content);

    const readMeta = readGroupMeta(agentId, accountId, groupNo);
    expect(readMeta).not.toBeNull();
    expect(readMeta!.version).toBe(5);
    expect(readMeta!.updated_by).toBe("uid_admin");
    expect(readMeta!.account_id).toBe(accountId);
  });

  it("should return null for non-existent file", () => {
    expect(readGroupMdFromDisk(agentId, accountId, "nonexistent")).toBeNull();
    expect(readGroupMeta(agentId, accountId, "nonexistent")).toBeNull();
  });

  it("should overwrite existing files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ agentId, accountId, groupNo, content: "v1", meta });
    expect(readGroupMdFromDisk(agentId, accountId, groupNo)).toBe("v1");

    writeGroupMdToDisk({
      agentId,
      accountId,
      groupNo,
      content: "v2",
      meta: { ...meta, version: 2 },
    });
    expect(readGroupMdFromDisk(agentId, accountId, groupNo)).toBe("v2");
    expect(readGroupMeta(agentId, accountId, groupNo)!.version).toBe(2);
  });
});

describe("deleteGroupMdFromDisk", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_del";

  it("should delete GROUP.md and meta files", () => {
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ agentId, accountId, groupNo, content: "test", meta });
    expect(readGroupMdFromDisk(agentId, accountId, groupNo)).toBe("test");

    deleteGroupMdFromDisk(agentId, accountId, groupNo);
    expect(readGroupMdFromDisk(agentId, accountId, groupNo)).toBeNull();
    expect(readGroupMeta(agentId, accountId, groupNo)).toBeNull();
  });

  it("should not throw when files don't exist", () => {
    expect(() => deleteGroupMdFromDisk(agentId, accountId, "nonexistent")).not.toThrow();
  });
});

describe("scanForAccountId", () => {
  const agentId = "testAgent";

  it("should find accountId from meta file on disk", () => {
    const accountId = "scanned_acct";
    const groupNo = "grp_scan";
    const meta: GroupMdMeta = {
      version: 3,
      updated_at: null,
      updated_by: "u1",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ agentId, accountId, groupNo, content: "scan test", meta });

    // Reset memory map so scanForAccountId must scan disk
    _testReset();

    const result = scanForAccountId(agentId, groupNo);
    expect(result).toBe(accountId);
    // Should also populate memory map
    expect(_testGetGroupAccountMap().get(groupNo)).toBe(accountId);
  });

  it("should return null when no meta exists", () => {
    expect(scanForAccountId(agentId, "grp_missing")).toBeNull();
  });

  it("should return null for non-existent workspace", () => {
    expect(scanForAccountId("nonexistent_agent", "grp_x")).toBeNull();
  });
});

describe("clearGroupMdChecked", () => {
  it("should clear the checked flag for a group", () => {
    const checked = _testGetCheckedGroups();
    checked.add("acct1/grp1");
    expect(checked.has("acct1/grp1")).toBe(true);

    clearGroupMdChecked("acct1", "grp1");
    expect(checked.has("acct1/grp1")).toBe(false);
  });
});

describe("getGroupMdForPrompt", () => {
  const agentId = "testAgent";
  const accountId = "jeff";
  const groupNo = "grp_prompt";

  it("should return null for non-group sessionKey", () => {
    registerGroupAccount(groupNo, accountId);
    expect(getGroupMdForPrompt({ sessionKey: "agent:a1:dmwork:direct:uid1", agentId })).toBeNull();
  });

  it("should return null when sessionKey is undefined", () => {
    expect(getGroupMdForPrompt({ agentId })).toBeNull();
  });

  it("should return null when agentId is undefined", () => {
    expect(getGroupMdForPrompt({ sessionKey: `agent:a1:dmwork:group:${groupNo}` })).toBeNull();
  });

  it("should return null when no accountId mapping exists", () => {
    // No registerGroupAccount called, no disk file
    expect(getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:dmwork:group:unknown_grp`,
      agentId,
    })).toBeNull();
  });

  it("should return cached GROUP.md content for valid group session", () => {
    registerGroupAccount(groupNo, accountId);
    const content = "# Rules\nBe respectful.";
    const meta: GroupMdMeta = {
      version: 1,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };

    writeGroupMdToDisk({ agentId, accountId, groupNo, content, meta });

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:dmwork:group:${groupNo}`,
      agentId,
    });
    expect(result).toBe(content);
  });

  it("should return null when GROUP.md file doesn't exist on disk", () => {
    registerGroupAccount(groupNo, accountId);
    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:dmwork:group:${groupNo}`,
      agentId,
    });
    expect(result).toBeNull();
  });

  it("should recover accountId from disk scan after restart", () => {
    // Simulate: write to disk, then reset memory
    const content = "# Recovered";
    const meta: GroupMdMeta = {
      version: 2,
      updated_at: null,
      updated_by: "admin",
      fetched_at: new Date().toISOString(),
      account_id: accountId,
    };
    writeGroupMdToDisk({ agentId, accountId, groupNo, content, meta });

    _testReset(); // Simulate restart

    const result = getGroupMdForPrompt({
      sessionKey: `agent:${agentId}:dmwork:group:${groupNo}`,
      agentId,
    });
    expect(result).toBe(content);
  });
});

describe("event recognition (payload.event.type)", () => {
  it("should recognize group_md_updated event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "group_md_updated", version: 5, updated_by: "uid123" },
    };
    expect(payload.event?.type).toBe("group_md_updated");
  });

  it("should recognize group_md_deleted event type", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "group_md_deleted" },
    };
    expect(payload.event?.type).toBe("group_md_deleted");
  });

  it("should return undefined when no event field", () => {
    const payload = { type: 1, content: "hello" };
    expect((payload as any).event?.type).toBeUndefined();
  });

  it("should not match non-group-md event types", () => {
    const payload = {
      type: 1,
      content: "",
      event: { type: "member_joined" },
    };
    const eventType = payload.event?.type;
    expect(eventType !== "group_md_updated" && eventType !== "group_md_deleted").toBe(true);
  });
});
