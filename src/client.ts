import * as React from 'react'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useInlineEdit } from './inline-edit'
import { DeleteAction, EyeIcon, NewVariableButton, NewVariableForm } from './client-actions'
import { ClientError, dictionaries, errorLabel, layerLabel, LOCALE_NS, reasonLabel } from './client-locales'
import type { ErrorResponse, LocaleProps } from './client-locales'
import {
  Empty, GroupHeading, Key, Meta, Note, Placeholder, Row,
  RowActions, ScrollArea, T, Toolbar, Value, installClientStyles,
} from './client-ui'

const { useState, useEffect, useCallback, useRef } = React
const { Button, Input, Modal } = Primitives
// DSH 0.1.7 renamed size-suffixed icons to stroke variants.
const IconChevronDownOutline14 = Primitives.IconChevronDownOutlineRegular ?? Primitives.IconChevronDownOutline14
const EnvironmentIcon = Primitives.IconSlidersTwoOutlineRegular ?? Primitives.IconSettingsOutline16
const IconEditOutline16 = Primitives.IconEditOutlineRegular ?? Primitives.IconEditOutline16
const IconRefreshOutline16 = Primitives.IconRefreshOutlineRegular ?? Primitives.IconRefreshOutline16
const IconSearchOutline16 = Primitives.IconSearchOutlineRegular ?? Primitives.IconSearchOutline16
const IconTrashOutline16 = Primitives.IconTrashOutlineRegular ?? Primitives.IconTrashOutline16
const STATE_URL = '/api/dsh-environment-tray/state'
const VALUE_URL = '/api/dsh-environment-tray/value'
const ENV_WRITE_URL = '/api/dsh-environment-tray/env'
const ENV_READ_URL = '/api/dsh-environment-tray/env/read'
const REGISTRY_URL = '/api/dsh-environment-tray/registry'
const CREDENTIAL_STATE_URL = '/api/dsh-environment-tray/credential-state'
const CREDENTIAL_WRITE_URL = '/api/dsh-environment-tray/credentials'

interface LayerView {
  layer: string
  writable?: boolean
  redacted?: boolean
  valueSummary?: { preview: string; length: number; truncated?: boolean }
  valueLength?: number
  registryType?: string
  blockedCode?: string
  path?: string
}
interface VariableView {
  name: string
  effective: string
  layers: LayerView[]
  runtimeManaged?: boolean
  shadowed?: boolean
  sensitive?: boolean
  layerCount?: number
}
interface EnvState {
  variables?: VariableView[]
  warnings?: { code?: string; path?: string; message?: string }[]
  os?: { supported?: boolean; scopes?: Record<string, { error?: string | null }> }
  blockedReasonText?: Record<string, string>
}
interface CredentialInfoView {
  source?: string
  configured?: boolean
  editable?: boolean
  sourceLabel?: string
  blockedReason?: string
}
interface UndoRecord { name: string; value: string; type: string; scope: string }
interface HostResponse extends ErrorResponse {
  ok?: boolean
  value?: string
  revision?: string
  restartRequired?: boolean
  undo?: Omit<UndoRecord, 'scope'>
}
type InputChangeEvent = { target: { value: string } }

const WRITABLE_ORDER = ['project-env', 'user-env', 'os-user', 'os-machine']
const CREDENTIAL_HINTS = /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)($|_)/i

async function postJson(url: string, body: unknown): Promise<HostResponse> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const parsed = await res.json() as HostResponse
  if (res.ok && parsed.ok === true) return parsed
  throw new ClientError(parsed, res.status)
}

async function readValue(name: string, layer: string): Promise<HostResponse & { value: string }> {
  const result = await postJson(VALUE_URL, { name, layer })
  if (typeof result.value !== 'string') throw new ClientError({ error: 'read-failed' })
  return result as HostResponse & { value: string }
}

async function readRevision(layer: string): Promise<string> {
  const result = await postJson(ENV_READ_URL, { layer })
  if (typeof result.revision !== 'string') throw new ClientError({ error: 'read-failed' })
  return result.revision
}

async function removeValue(name: string, layer: string): Promise<HostResponse> {
  if (layer.startsWith('os-')) return postJson(REGISTRY_URL, { scope: layer, name, unset: true })
  if (layer === 'credential') return postJson(CREDENTIAL_WRITE_URL, { ref: name, unset: true })
  return postJson(ENV_WRITE_URL, {
    layer, expectedRevision: await readRevision(layer), edits: [{ op: 'unset', name }],
  })
}

async function copyValue(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const input = document.createElement('textarea')
  input.setAttribute('data-dsh-environment-tray-copy', 'true')
  input.value = value
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  const focused = document.activeElement as HTMLElement | null
  try {
    input.select()
    if (!document.execCommand('copy')) throw new ClientError({ error: 'copy-failed' })
  } finally {
    input.remove()
    focused?.focus()
  }
}

function CopyIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, 'aria-hidden': true,
  }, React.createElement('rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }),
  React.createElement('path', { d: 'M16 8V4H4v12h4' }))
}
function CancelIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, 'aria-hidden': true,
  }, React.createElement('path', { d: 'm6 6 12 12M18 6 6 18' }))
}

function DraftValue(props: LocaleProps & { edit: ReturnType<typeof useInlineEdit<HostResponse>>; name: string; sensitive?: boolean }) {
  const { edit, name, sensitive, t } = props
  const [copyError, setCopyError] = useState<unknown>(null)
  const multiline = /[\r\n]/.test(edit.draft)
  const masked = sensitive && !edit.visible
  return React.createElement('span', { className: 'dsh-environment-tray-valuecell dsh-environment-tray-value', style: { fontSize: T.value.fontSize } },
    React.createElement(multiline && !masked ? 'textarea' : 'input', {
      className: 'dsh-environment-tray-input', 'aria-label': t('valueLabel', { name }), 'aria-invalid': edit.error !== null,
      value: edit.draft, autoFocus: true, type: masked ? 'password' : 'text',
      rows: multiline ? Math.min(4, edit.draft.split(/\r\n|\r|\n/).length) : undefined,
      title: t(multiline && masked ? 'multilineHint' : 'editHint'),
      readOnly: !edit.ready || edit.busy || multiline && masked, 'aria-busy': edit.busy,
      placeholder: edit.ready ? '' : t('loading'),
      onChange: (e: InputChangeEvent) => edit.setDraft(e.target.value), onKeyDown: edit.onKeyDown,
    }),
    sensitive ? React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(EyeIcon, { hidden: edit.visible }),
      'aria-label': t(edit.visible ? 'hideInput' : 'showInput'), title: t(edit.visible ? 'hideInput' : 'showInput'),
      disabled: !edit.ready || edit.busy, onClick: () => edit.setVisible(!edit.visible),
    }) : React.createElement('span', null),
    React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(CopyIcon), 'aria-label': t('copyValue'), title: t('copyValue'),
      disabled: !edit.ready || edit.busy, onClick: async () => {
        setCopyError(null)
        try { await copyValue(edit.draft) } catch (error) { setCopyError(error) }
      },
    }),
    edit.error !== null || copyError !== null ? React.createElement('span', {
      className: 'dsh-environment-tray-value-error', role: 'alert', style: T.meta,
    }, errorLabel(t, edit.error ?? copyError)) : null,
  )
}

/** Each value owns its temporary visibility; hiding discards the fetched plaintext. */
function ValueCell(props: LocaleProps & { name: string; layer: LayerView; sensitive?: boolean }) {
  const { t } = props
  const maskedByDefault = props.sensitive === true || props.layer.redacted === true
  const [visible, setVisible] = useState(!maskedByDefault)
  const [fullValue, setFullValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current += 1 }, [])
  const toggle = async () => {
    setError(null)
    setCopied(false)
    if (visible) {
      generation.current += 1
      setVisible(false)
      setFullValue(null)
      return
    }
    const request = ++generation.current
    setBusy(true)
    try {
      const result = await readValue(props.name, props.layer.layer)
      if (request !== generation.current) return
      setFullValue(result.value)
      setVisible(true)
    } catch (error) {
      if (request === generation.current) setError(error)
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const copy = async () => {
    const request = ++generation.current
    setBusy(true)
    setError(null)
    try {
      const value = fullValue ?? (await readValue(props.name, props.layer.layer)).value
      if (request !== generation.current) return
      await copyValue(value)
      if (request === generation.current) setCopied(true)
    } catch (error) {
      if (request === generation.current) setError(error)
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const text = visible ? fullValue ?? props.layer.valueSummary?.preview ?? '—' : null
  return React.createElement('span', { className: 'dsh-environment-tray-valuecell dsh-environment-tray-value', style: { fontSize: T.value.fontSize } },
    React.createElement(Value, { masked: !visible, expanded: fullValue !== null, title: visible ? text ?? undefined : undefined }, text),
    React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(EyeIcon, { hidden: visible }),
      title: t(visible ? 'hideValue' : 'showValue'), 'aria-label': t(visible ? 'hideValue' : 'showValue'),
      'aria-pressed': visible, disabled: busy, onClick: toggle,
    }),
    React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(CopyIcon),
      title: t(copied ? 'copied' : 'copyValue'), 'aria-label': t(copied ? 'copied' : 'copyValue'),
      disabled: busy, onClick: copy,
    }),
    error === null ? null : React.createElement('span', { role: 'alert', style: T.meta }, errorLabel(t, error)),
  )
}

function EditActions(props: LocaleProps & {
  edit: ReturnType<typeof useInlineEdit<HostResponse>>; available: boolean; remove?: React.ReactNode;
  label?: string; extra?: React.ReactNode;
}) {
  const { edit, t } = props
  return React.createElement(RowActions, null,
    React.createElement('span', null, edit.editing ? React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(CancelIcon),
      title: t('cancelEdit'), 'aria-label': t('cancelEdit'), disabled: edit.busy && edit.ready, onClick: edit.cancel,
    }) : props.available ? React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(IconEditOutline16),
      title: props.label ?? t('edit'), 'aria-label': props.label ?? t('edit'), onClick: edit.begin,
    }) : null),
    React.createElement('span', null, props.remove),
    React.createElement('span', null, props.extra),
  )
}

function VariableRow(props: LocaleProps & {
  variable: VariableView; state: EnvState; version: number; expanded: boolean;
  onToggle: (name: string) => void; onSaved: (result?: HostResponse) => void; onDeleted: (undo: UndoRecord) => void;
}) {
  const { variable, state, version, expanded, onToggle, onSaved, onDeleted, t } = props
  const effective = variable.layers.find((l) => l.layer === variable.effective)
  const target = variable.layers.find((l) => l.writable && WRITABLE_ORDER.includes(l.layer))
  const edit = useInlineEdit<HostResponse>({
    read: target ? () => readValue(variable.name, target.layer) : undefined,
    write: async (value, revision) => {
      if (!target) throw new ClientError({ error: 'not-editable' })
      if (target.layer.startsWith('os-')) return postJson(REGISTRY_URL, {
        scope: target.layer, name: variable.name, value, type: target.registryType ?? 'REG_SZ',
      })
      if (revision === undefined) throw new ClientError({ error: 'reopen-editor' })
      return postJson(ENV_WRITE_URL, {
        layer: target.layer, expectedRevision: revision, edits: [{ op: 'set', name: variable.name, value }],
      })
    },
    onSaved,
  })
  return React.createElement('div', null,
    React.createElement(Row, { active: edit.editing || expanded, onBlur: edit.editing ? edit.onBlur : undefined },
      React.createElement(Key, { title: variable.name }, variable.name),
      edit.editing ? React.createElement(DraftValue, { t, edit, name: variable.name, sensitive: variable.sensitive })
        : effective ? React.createElement(ValueCell, {
          t, key: version, name: variable.name, layer: effective, sensitive: variable.sensitive,
        }) : React.createElement(Value, null, '—'),
      React.createElement('span', { className: 'dsh-environment-tray-row-meta' },
        React.createElement(Meta, { parts: edit.editing ? [
          edit.busy ? t(edit.ready ? 'saving' : 'loading') : layerLabel(t, target!.layer),
        ] : [layerLabel(t, variable.effective), variable.shadowed ? t('layerCount', { count: variable.layers.length }) : null] }),
        React.createElement(EditActions, { t, edit, available: !!target,
          remove: target ? React.createElement(DeleteAction, {
            t, key: target.layer, name: variable.name, layer: target.layer, fallback: variable.layers.length > 1,
            icon: React.createElement(IconTrashOutline16), disabled: edit.busy && edit.ready,
            onOpen: edit.pause, onClose: edit.resume, remove: async () => {
              const result = await removeValue(variable.name, target.layer)
              edit.cancel()
              if (result.undo) onDeleted({ ...result.undo, scope: target.layer })
              onSaved(result)
            },
          }) : null,
          extra: variable.shadowed ? React.createElement(Button, {
            variant: 'ghost', size: 'sm', icon: React.createElement(IconChevronDownOutline14),
            title: t(expanded ? 'collapseLayers' : 'expandLayers'), 'aria-label': t(expanded ? 'collapseLayers' : 'expandLayers'),
            onClick: () => onToggle(variable.name),
          }) : null,
        }),
      ),
    ),
    expanded ? React.createElement('div', { className: 'dsh-environment-tray-layers' },
      variable.layers.map((layer) => React.createElement(Row, { key: layer.layer },
        React.createElement(Key, { title: layer.path }, layerLabel(t, layer.layer)),
        React.createElement(ValueCell, { t, key: version, name: variable.name, layer, sensitive: variable.sensitive }),
        React.createElement('span', { className: 'dsh-environment-tray-row-meta' },
          React.createElement('span', {
            style: T.meta, title: layer.blockedCode ? reasonLabel(t, layer.blockedCode, state.blockedReasonText?.[layer.blockedCode]) : layer.path,
          }, layer.layer === variable.effective ? t('current') : null),
          React.createElement(RowActions),
        ),
      )),
    ) : null,
  )
}

function CredentialRow(props: LocaleProps & { name: string; info: CredentialInfoView; version: number; onSaved: () => void }) {
  const { name, info, version, onSaved, t } = props
  const edit = useInlineEdit<HostResponse>({
    read: info.editable ? () => info.configured ? readValue(name, 'credential') : Promise.resolve({ value: '' }) : undefined,
    write: (value) => postJson(CREDENTIAL_WRITE_URL, { ref: name, value }),
    onSaved,
  })
  return React.createElement(Row, { active: edit.editing, onBlur: edit.editing ? edit.onBlur : undefined },
    React.createElement(Key, null, name),
    edit.editing ? React.createElement(DraftValue, { t, edit, name, sensitive: true })
      : info.configured ? React.createElement(ValueCell, {
        t, key: version, name, layer: { layer: 'credential', redacted: true }, sensitive: true,
      }) : React.createElement(Value, null, '—'),
    React.createElement('span', { className: 'dsh-environment-tray-row-meta' },
      React.createElement(Meta, { parts: [edit.editing
        ? edit.busy ? t(edit.ready ? 'saving' : 'loading') : t('layer.file')
        : info.configured ? info.source ? layerLabel(t, info.source) : info.sourceLabel : t('unset')] }),
      React.createElement(EditActions, { t, edit, available: !!info.editable,
        remove: info.configured && info.editable ? React.createElement(DeleteAction, {
          t, name, layer: 'credential', icon: React.createElement(IconTrashOutline16),
          disabled: edit.busy && edit.ready, onOpen: edit.pause, onClose: edit.resume,
          remove: async () => { await removeValue(name, 'credential'); edit.cancel(); onSaved() },
        }) : null,
        label: t(info.configured ? 'replace' : 'set') }),
    ),
  )
}

function CredentialPanel(props: LocaleProps & { names: string[]; onSaved: () => void; version: number }) {
  const { t } = props
  const [status, setStatus] = useState<Record<string, CredentialInfoView> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const key = props.names.join(',')
  useEffect(() => {
    let active = true
    if (!key) { setStatus({}); return }
    fetch(CREDENTIAL_STATE_URL + '?refs=' + encodeURIComponent(key))
      .then(async (res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
      .then((body) => { if (active) setStatus(body.available === true ? body.refs ?? {} : {}) })
      .catch((error) => { if (active) setError(error) })
    return () => { active = false }
  }, [key, props.version])
  if (!props.names.length) return null
  return React.createElement(React.Fragment, null,
    React.createElement(GroupHeading, { title: t('layer.credential'), count: props.names.length }),
    error !== null ? React.createElement(Note, null, t('readError', { error: errorLabel(t, error) })) : null,
    status === null ? React.createElement(Empty, null, t('loading')) : props.names.map((name) =>
      React.createElement(CredentialRow, { t, key: name, name, info: status[name] ?? {}, version: props.version, onSaved: props.onSaved })),
  )
}
function EnvManagerPanel({ t }: LocaleProps) {
  const [state, setState] = useState<EnvState | null>(null)
  const [version, setVersion] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [undo, setUndo] = useState<UndoRecord | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [restartNeeded, setRestartNeeded] = useState(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    setError(null)
    try {
      const res = await fetch(STATE_URL)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (request !== generation.current) return
      setState(body)
      setVersion((version) => version + 1)
    } catch (error) { if (request === generation.current) setError(error) }
  }, [])
  useEffect(() => { void load(); return () => { generation.current += 1 } }, [load])
  const onSaved = (result?: HostResponse) => {
    if (result?.restartRequired) setRestartNeeded(true)
    void load()
  }
  const create = async (layer: string, name: string, value: string) => {
    const result = layer.startsWith('os-')
      ? await postJson(REGISTRY_URL, { scope: layer, name, value, type: 'REG_SZ', createOnly: true })
      : await postJson(ENV_WRITE_URL, {
        layer, expectedRevision: await readRevision(layer), createOnly: true, edits: [{ op: 'set', name, value }],
      })
    setAdding(false)
    if (!name.toUpperCase().includes(filter.trim().toUpperCase())) setFilter('')
    onSaved(result)
  }
  const toggle = (name: string) => setExpanded((prev) => ({ ...prev, [name]: !prev[name] }))
  const undoRemove = async () => {
    if (!undo) return
    setUndoBusy(true)
    try {
      const result = await postJson(REGISTRY_URL, { scope: undo.scope, name: undo.name, value: undo.value, type: undo.type })
      setUndo(null)
      onSaved(result)
    } catch (error) { setError(error) }
    finally { setUndoBusy(false) }
  }
  if (!state) return error !== null
    ? React.createElement(React.Fragment, null, React.createElement(Placeholder, null, t('readError', { error: errorLabel(t, error) })),
      React.createElement(Button, { onClick: load }, t('retry')))
    : React.createElement(Placeholder, null, t('loadingEnvironment'))
  const variables = state.variables ?? []
  const needle = filter.trim().toUpperCase()
  const shown = variables.filter((v) => v.name.toUpperCase().includes(needle))
  const headings = [
    ['runtime', t('group.runtime')], ['project-env', t('layer.project')], ['user-env', t('layer.user')],
    ['credential', t('group.credential')], ['os-user', t('layer.osUser')],
    ['os-machine', t('layer.osMachine')], ['readonly', t('group.readonly')],
  ]
  const groupOf = (v: VariableView) => v.runtimeManaged ? 'runtime' : v.effective === 'credential'
    ? 'credential' : WRITABLE_ORDER.find((key) => v.layers.some((l) => l.layer === key && l.writable))
      ?? (WRITABLE_ORDER.includes(v.effective) ? v.effective : 'readonly')
  const credentialNames = shown.filter((v) => CREDENTIAL_HINTS.test(v.name)).map((v) => v.name).sort()
  const rows: React.ReactNode[] = []
  for (const [key, title] of headings) {
    const items = shown.filter((v) => groupOf(v) === key).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    if (items.length) rows.push(React.createElement(GroupHeading, { key: 'h-' + key, title, count: items.length }),
      ...items.map((variable) => React.createElement(VariableRow, {
        t, key: variable.name, variable, state, version, expanded: expanded[variable.name] === true,
        onToggle: toggle, onSaved, onDeleted: setUndo,
      })))
    if (key === 'credential') rows.push(React.createElement(CredentialPanel, {
      t, key: 'credentials', names: credentialNames, onSaved, version,
    }))
  }
  return React.createElement(React.Fragment, null,
    React.createElement(Toolbar, null,
      React.createElement(Input, {
        icon: React.createElement(IconSearchOutline16), placeholder: t('search'), value: filter,
        style: { flex: 1, fontSize: 12 }, onChange: (e: InputChangeEvent) => setFilter(e.target.value),
      }),
      React.createElement(Button, {
        variant: 'ghost', size: 'sm', icon: React.createElement(IconRefreshOutline16),
        title: t('refresh'), 'aria-label': t('refresh'), onClick: load,
      }),
      React.createElement(NewVariableButton, { t, onClick: () => setAdding(true) }),
      React.createElement('span', { style: T.meta }, needle ? `${shown.length} / ${variables.length}` : String(variables.length)),
    ),
    adding ? React.createElement(NewVariableForm, {
      t, create, onCancel: () => setAdding(false), layers: ['user-env', 'project-env',
        ...(state.os?.supported === true ? ['os-user', 'os-machine'].filter((layer) => !state.os?.scopes?.[layer]?.error) : []),
      ],
    }) : null,
    error !== null ? React.createElement(Note, null, t('readError', { error: errorLabel(t, error) })) : null,
    restartNeeded ? React.createElement(Note, null, t('restart')) : null,
    undo ? React.createElement('div', { className: 'dsh-environment-tray-editor' },
      React.createElement('span', { style: T.meta }, t('deleted', { name: undo.name })),
      React.createElement(Button, { variant: 'ghost', size: 'sm', disabled: undoBusy, onClick: undoRemove }, t('undoDelete')),
    ) : null,
    state.warnings?.map((warning, i) => React.createElement(Note, { key: i }, warning.code === 'bom'
      ? t('warning.bom', { path: warning.path ?? '.env' }) : warning.message)),
    Object.entries(state.os?.scopes ?? {}).filter(([, scope]) => scope.error).map(([key]) =>
      React.createElement(Note, { key }, t('scopeReadError', { scope: layerLabel(t, key) }))),
    React.createElement(ScrollArea, null, rows, shown.length ? null : React.createElement(Empty, null, t('noMatches'))),
  )
}

function EnvManagerAction({ t }: LocaleProps) {
  const [open, setOpen] = useState(false)
  return React.createElement(React.Fragment, null,
    React.createElement(Button, {
      variant: 'ghost', size: 'sm', icon: React.createElement(EnvironmentIcon),
      title: t('title'), 'aria-label': t('title'), onClick: () => setOpen(true),
    }),
    React.createElement(Modal, {
      open, onClose: () => setOpen(false), title: t('title'), closeLabel: t('close'), className: 'dsh-environment-tray-dialog',
    }, open ? React.createElement(EnvManagerPanel, { t }) : null),
  )
}

const inject = ['slots', 'locale']
function apply(ctx: {
  effect(callback: () => (() => void), label: string): unknown
  locale: { register(namespace: string, dicts: typeof dictionaries): () => void }
  slots: {
  inject(name: string, callback: () => void): unknown
  register(options: Record<string, unknown>, component: (props: LocaleProps) => unknown): unknown
} }) {
  installClientStyles()
  ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries), 'dsh-environment-tray: browser dictionaries')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'dsh-environment-tray', order: 100, locale: LOCALE_NS,
  }, EnvManagerAction))
}
export { apply, inject, EnvManagerAction, EnvManagerPanel }
