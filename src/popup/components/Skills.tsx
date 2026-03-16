import React from "react";
import {
  getSkills,
  addSkill,
  updateSkill,
  deleteSkill,
  parseToolSteps,
  serializeToolSteps,
  type AgentSkill,
  type SkillTool,
} from "@/utils/skillsStorage";
import "../styles/Skills.css";

const EMPTY_FORM = {
  name: "",
  description: "",
  instructions: "",
  enabled: true,
};
const EMPTY_TOOL = { name: "", description: "", stepsRaw: "" };

export default function Skills() {
  const [skills, setSkills] = React.useState<AgentSkill[]>([]);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [showNew, setShowNew] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  const [showImport, setShowImport] = React.useState(false);
  const [importJson, setImportJson] = React.useState("");
  const [importError, setImportError] = React.useState<string | null>(null);
  const [importOk, setImportOk] = React.useState(false);
  // Tool editing state — keyed by skillId+toolIndex or "new"
  const [toolEditing, setToolEditing] = React.useState<{
    skillId: string;
    idx: number | "new";
  } | null>(null);
  const [toolForm, setToolForm] = React.useState(EMPTY_TOOL);

  React.useEffect(() => {
    getSkills().then(setSkills);
  }, []);
  const reload = () => getSkills().then(setSkills);

  const handleToggle = async (skill: AgentSkill) => {
    await updateSkill(skill.id, { enabled: !skill.enabled });
    reload();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this skill?")) return;
    await deleteSkill(id);
    if (editing === id) {
      setEditing(null);
      setForm(EMPTY_FORM);
    }
    reload();
  };

  const handleEdit = (skill: AgentSkill) => {
    setEditing(skill.id);
    setForm({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      enabled: skill.enabled,
    });
    setShowNew(false);
    setToolEditing(null);
  };

  const handleSaveEdit = async () => {
    if (!editing || !form.name.trim()) return;
    await updateSkill(editing, form);
    setSaved(editing);
    setTimeout(() => setSaved(null), 1500);
    setEditing(null);
    setForm(EMPTY_FORM);
    reload();
  };

  const handleAddNew = async () => {
    if (!form.name.trim()) return;
    const s = await addSkill({ ...form, tools: [] });
    setSaved(s.id);
    setTimeout(() => setSaved(null), 1500);
    setShowNew(false);
    setForm(EMPTY_FORM);
    reload();
  };

  const handleFieldChange =
    (field: keyof typeof EMPTY_FORM) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const val =
        field === "enabled"
          ? (e.target as HTMLInputElement).checked
          : e.target.value;
      setForm((prev) => ({ ...prev, [field]: val }));
    };

  const openNew = () => {
    setShowNew(true);
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowImport(false);
  };
  const cancelForm = () => {
    setShowNew(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const openImport = () => {
    setShowImport(true);
    setShowNew(false);
    setEditing(null);
    setImportJson("");
    setImportError(null);
    setImportOk(false);
  };
  const cancelImport = () => {
    setShowImport(false);
    setImportJson("");
    setImportError(null);
  };

  const handleImport = async () => {
    setImportError(null);
    let parsed: any;
    try {
      parsed = JSON.parse(importJson.trim());
    } catch {
      setImportError("Invalid JSON — check for missing quotes or brackets.");
      return;
    }
    if (!parsed.name || typeof parsed.name !== "string") {
      setImportError('Missing required field: "name"');
      return;
    }
    if (!parsed.instructions && !parsed.description) {
      setImportError('Missing required field: "instructions"');
      return;
    }
    const tools: SkillTool[] = [];
    if (Array.isArray(parsed.tools)) {
      for (const t of parsed.tools) {
        if (!t.name) continue;
        tools.push({
          name: String(t.name).trim().replace(/\s+/g, "_").toLowerCase(),
          description: String(t.description ?? "").trim(),
          steps: typeof t.steps === "string" ? parseToolSteps(t.steps) : [],
        });
      }
    }
    await addSkill({
      name: String(parsed.name).trim(),
      description: String(parsed.description ?? "").trim(),
      instructions: String(
        parsed.instructions ?? parsed.description ?? "",
      ).trim(),
      enabled: true,
      tools,
    });
    setImportOk(true);
    setTimeout(() => {
      setShowImport(false);
      setImportJson("");
      setImportOk(false);
      reload();
    }, 1000);
  };

  // ── Tool CRUD ──────────────────────────────────────────────────────────────

  const openNewTool = (skillId: string) => {
    setToolEditing({ skillId, idx: "new" });
    setToolForm(EMPTY_TOOL);
  };

  const openEditTool = (skillId: string, idx: number, tool: SkillTool) => {
    setToolEditing({ skillId, idx });
    setToolForm({
      name: tool.name,
      description: tool.description,
      stepsRaw: serializeToolSteps(tool.steps),
    });
  };

  const cancelToolForm = () => {
    setToolEditing(null);
    setToolForm(EMPTY_TOOL);
  };

  const handleSaveTool = async () => {
    if (!toolEditing || !toolForm.name.trim()) return;
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === toolEditing.skillId);
    if (!skill) return;
    const newTool: SkillTool = {
      name: toolForm.name.trim().replace(/\s+/g, "_").toLowerCase(),
      description: toolForm.description.trim(),
      steps: parseToolSteps(toolForm.stepsRaw),
    };
    const tools = [...(skill.tools ?? [])];
    if (toolEditing.idx === "new") {
      tools.push(newTool);
    } else {
      tools[toolEditing.idx] = newTool;
    }
    await updateSkill(toolEditing.skillId, { tools });
    setToolEditing(null);
    setToolForm(EMPTY_TOOL);
    reload();
  };

  const handleDeleteTool = async (skillId: string, idx: number) => {
    if (!confirm("Delete this tool?")) return;
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) return;
    const tools = (skill.tools ?? []).filter((_, i) => i !== idx);
    await updateSkill(skillId, { tools });
    reload();
  };

  return (
    <div className="skills-panel">
      <div className="skills-header-row">
        <div>
          <h3 className="skills-title">🧠 Agent Skills</h3>
          <p className="skills-hint">
            Skills inject instructions and custom tools into the AI prompt.
            Active skills are always included.
          </p>
        </div>
        <div className="skills-header-btns">
          <button
            className="skills-import-btn"
            onClick={openImport}
            disabled={showImport || showNew}
          >
            ⬇ Import JSON
          </button>
          <button
            className="skills-add-btn"
            onClick={openNew}
            disabled={showNew || showImport}
          >
            + New
          </button>
        </div>
      </div>

      {showImport && (
        <div className="skill-import-panel">
          <label className="skill-form-label">
            Paste GPT-generated skill JSON
          </label>
          <textarea
            className="skill-form-textarea skill-import-textarea"
            rows={8}
            placeholder={
              '{ "name": "...", "description": "...", "instructions": "1. ...", "tools": [] }'
            }
            value={importJson}
            onChange={(e) => {
              setImportJson(e.target.value);
              setImportError(null);
            }}
            spellCheck={false}
          />
          {importError && (
            <div className="skill-import-error">{importError}</div>
          )}
          {importOk && <div className="skill-import-ok">✓ Skill imported!</div>}
          <div className="skill-form-btns">
            <button className="skill-cancel-btn" onClick={cancelImport}>
              Cancel
            </button>
            <button
              className="skill-save-btn"
              onClick={handleImport}
              disabled={!importJson.trim() || importOk}
            >
              Import
            </button>
          </div>
        </div>
      )}

      {showNew && (
        <SkillForm
          form={form}
          onChange={handleFieldChange}
          onSave={handleAddNew}
          onCancel={cancelForm}
          saveLabel="Add Skill"
        />
      )}

      {skills.length === 0 && !showNew && (
        <div className="skills-empty">
          No skills yet. Click <strong>+ New</strong> to create one.
        </div>
      )}

      {skills.map((skill) => (
        <div
          key={skill.id}
          className={`skill-card ${skill.enabled ? "skill-card--active" : "skill-card--off"}`}
        >
          {editing === skill.id ? (
            <SkillForm
              form={form}
              onChange={handleFieldChange}
              onSave={handleSaveEdit}
              onCancel={cancelForm}
              saveLabel={saved === skill.id ? "✓ Saved" : "Save"}
            />
          ) : (
            <>
              <div className="skill-card-header">
                <label
                  className="skill-toggle-label"
                  title={skill.enabled ? "Disable skill" : "Enable skill"}
                >
                  <input
                    type="checkbox"
                    className="skill-toggle-input"
                    checked={skill.enabled}
                    onChange={() => handleToggle(skill)}
                  />
                  <span className="skill-toggle-track" />
                  <span className="skill-name">{skill.name}</span>
                </label>
                <div className="skill-card-actions">
                  <button
                    className="skill-edit-btn"
                    onClick={() => handleEdit(skill)}
                    title="Edit"
                  >
                    ✏️
                  </button>
                  <button
                    className="skill-del-btn"
                    onClick={() => handleDelete(skill.id)}
                    title="Delete"
                  >
                    🗑
                  </button>
                </div>
              </div>
              <p className="skill-description">{skill.description}</p>
              <pre className="skill-instructions">{skill.instructions}</pre>

              {/* ── Skill Tools ── */}
              <div className="skill-tools-section">
                <div className="skill-tools-header">
                  <span className="skill-tools-label">
                    🔧 Tools ({(skill.tools ?? []).length})
                  </span>
                  <button
                    className="skill-tool-add-btn"
                    onClick={() => openNewTool(skill.id)}
                  >
                    + Add Tool
                  </button>
                </div>

                {(skill.tools ?? []).map((tool, idx) => (
                  <div key={idx} className="skill-tool-row">
                    {toolEditing?.skillId === skill.id &&
                    toolEditing.idx === idx ? (
                      <ToolForm
                        form={toolForm}
                        onChange={(f, v) =>
                          setToolForm((p) => ({ ...p, [f]: v }))
                        }
                        onSave={handleSaveTool}
                        onCancel={cancelToolForm}
                      />
                    ) : (
                      <>
                        <div className="skill-tool-info">
                          <code className="skill-tool-name">{tool.name}</code>
                          <span className="skill-tool-desc">
                            {tool.description}
                          </span>
                          <span className="skill-tool-steps">
                            {tool.steps.length} step
                            {tool.steps.length !== 1 ? "s" : ""}
                          </span>
                        </div>
                        <div className="skill-tool-actions">
                          <button
                            className="skill-edit-btn"
                            onClick={() => openEditTool(skill.id, idx, tool)}
                            title="Edit tool"
                          >
                            ✏️
                          </button>
                          <button
                            className="skill-del-btn"
                            onClick={() => handleDeleteTool(skill.id, idx)}
                            title="Delete tool"
                          >
                            🗑
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}

                {toolEditing?.skillId === skill.id &&
                  toolEditing.idx === "new" && (
                    <ToolForm
                      form={toolForm}
                      onChange={(f, v) =>
                        setToolForm((p) => ({ ...p, [f]: v }))
                      }
                      onSave={handleSaveTool}
                      onCancel={cancelToolForm}
                    />
                  )}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Skill form ─────────────────────────────────────────────────────────────────

const EMPTY_FORM_TYPE = {
  name: "",
  description: "",
  instructions: "",
  enabled: true,
};

interface SkillFormProps {
  form: typeof EMPTY_FORM_TYPE;
  onChange: (
    field: keyof typeof EMPTY_FORM_TYPE,
  ) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onSave: () => void;
  onCancel: () => void;
  saveLabel: string;
}

function SkillForm({
  form,
  onChange,
  onSave,
  onCancel,
  saveLabel,
}: SkillFormProps) {
  return (
    <div className="skill-form">
      <div className="skill-form-group">
        <label className="skill-form-label">Name</label>
        <input
          className="skill-form-input"
          placeholder="e.g. Checkout Flow"
          value={form.name}
          onChange={onChange("name")}
        />
      </div>
      <div className="skill-form-group">
        <label className="skill-form-label">
          Description <span className="skill-form-hint">(shown to the AI)</span>
        </label>
        <input
          className="skill-form-input"
          placeholder="e.g. Handles e-commerce checkout and cart flows"
          value={form.description}
          onChange={onChange("description")}
        />
      </div>
      <div className="skill-form-group">
        <label className="skill-form-label">
          Instructions{" "}
          <span className="skill-form-hint">(injected into every prompt)</span>
        </label>
        <textarea
          className="skill-form-textarea"
          rows={4}
          placeholder={
            "1. Always verify item color/size before Add to Cart\n2. If captcha appears, use message() to notify user"
          }
          value={form.instructions}
          onChange={onChange("instructions")}
        />
      </div>
      <div className="skill-form-row">
        <label className="skill-form-enabled">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={onChange("enabled") as any}
          />
          <span>Enable after saving</span>
        </label>
        <div className="skill-form-btns">
          <button className="skill-cancel-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="skill-save-btn"
            onClick={onSave}
            disabled={!form.name.trim() || !form.instructions.trim()}
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tool form ──────────────────────────────────────────────────────────────────

interface ToolFormProps {
  form: typeof EMPTY_TOOL;
  onChange: (field: keyof typeof EMPTY_TOOL, value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function ToolForm({ form, onChange, onSave, onCancel }: ToolFormProps) {
  return (
    <div className="skill-form skill-tool-form">
      <div className="skill-form-group">
        <label className="skill-form-label">
          Tool name{" "}
          <span className="skill-form-hint">(lowercase, underscores OK)</span>
        </label>
        <input
          className="skill-form-input"
          placeholder="e.g. handle_otp"
          value={form.name}
          onChange={(e) => onChange("name", e.target.value)}
        />
      </div>
      <div className="skill-form-group">
        <label className="skill-form-label">
          When to use <span className="skill-form-hint">(shown to the AI)</span>
        </label>
        <input
          className="skill-form-input"
          placeholder="e.g. When an OTP input appears after login"
          value={form.description}
          onChange={(e) => onChange("description", e.target.value)}
        />
      </div>
      <div className="skill-form-group">
        <label className="skill-form-label">
          Steps{" "}
          <span className="skill-form-hint">
            one per line: click: Label · type: Label | text · navigate: url ·
            scroll: down · message: text
          </span>
        </label>
        <textarea
          className="skill-form-textarea"
          rows={5}
          placeholder={
            "click: Send OTP\nmessage: Waiting for OTP — please enter it manually\ntype: OTP | 000000"
          }
          value={form.stepsRaw}
          onChange={(e) => onChange("stepsRaw", e.target.value)}
        />
      </div>
      <div className="skill-form-row">
        <div />
        <div className="skill-form-btns">
          <button className="skill-cancel-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="skill-save-btn"
            onClick={onSave}
            disabled={!form.name.trim() || !form.stepsRaw.trim()}
          >
            Save Tool
          </button>
        </div>
      </div>
    </div>
  );
}
