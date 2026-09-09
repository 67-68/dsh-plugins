"""从 Anki collection 抽取 note 元数据，并按 action 写回。"""

from . import transaction_log


def _note_type(note):
    for attr in ("note_type", "model"):
        fn = getattr(note, attr, None)
        if callable(fn):
            try:
                result = fn()
                if result:
                    return result
            except Exception:
                pass
    return {}


def _fields_map(note):
    keys_fn = getattr(note, "keys", None)
    values_fn = getattr(note, "values", None)
    if callable(keys_fn) and callable(values_fn):
        return dict(zip(keys_fn(), values_fn()))
    try:
        return dict(note.items())
    except Exception:
        return {}


def _set_field(note, key, value):
    try:
        note[key] = value
        return True
    except Exception:
        return False


def _deck_name(col, did):
    try:
        return col.decks.name(did)
    except Exception:
        return None


def selected_note_ids(browser):
    try:
        nids = browser.selected_notes()
        if nids:
            return list(nids)
    except Exception:
        pass

    try:
        card_ids = browser.selected_cards()
    except Exception:
        card_ids = []

    col = getattr(browser, "col", None) or browser.mw.col
    nids = []
    for cid in card_ids:
        card = col.get_card(cid)
        if card.nid not in nids:
            nids.append(card.nid)
    return nids


def extract_payloads_from_nids(nids):
    from aqt import mw

    col = mw.col
    payloads = []
    for nid in nids:
        note = col.get_note(nid)
        fields = _fields_map(note)
        cards = list(note.cards())
        model = _note_type(note)

        lapses = sum(int(getattr(c, "lapses", 0) or 0) for c in cards)
        reps = sum(int(getattr(c, "reps", 0) or 0) for c in cards)
        ivls = [int(getattr(c, "ivl", 0) or 0) for c in cards]
        ease_values = []
        for c in cards:
            factor = getattr(c, "factor", None)
            if factor is None:
                factor = getattr(c, "ease", None)
            if factor:
                ease_values.append(int(factor))

        tmpls = model.get("tmpls", []) or []
        card_templates = []
        decks = []
        for c in cards:
            ord_ = int(getattr(c, "ord", 0) or 0)
            if 0 <= ord_ < len(tmpls):
                card_templates.append(tmpls[ord_].get("name") or ("Card %s" % (ord_ + 1)))
            else:
                card_templates.append("Card %s" % (ord_ + 1))
            did = getattr(c, "did", None)
            if did is not None:
                name = _deck_name(col, did)
                if name and name not in decks:
                    decks.append(name)

        payload = {
            "guid": note.guid,
            "id": note.id,
            "model": model.get("name") or "Unknown",
            "fields": fields,
            "tags": list(note.tags or []),
            "decks": decks,
            "card_templates": card_templates,
            "review": {
                "card_count": len(cards),
                "max_interval": max(ivls) if ivls else 0,
                "avg_ease": round(sum(ease_values) / len(ease_values), 1) if ease_values else 0,
                "lapses": lapses,
                "reps": reps,
                "leech": "leech" in (note.tags or []),
            },
        }
        payloads.append(payload)
    return payloads


def _reset_scheduling(note, col):
    card_ids = [c.id for c in note.cards()]
    if not card_ids:
        return
    try:
        col.sched.forget_cards(card_ids)
        return
    except AttributeError:
        pass
    try:
        col.sched.forgetCards(card_ids)
        return
    except AttributeError:
        pass
    try:
        col.sched.schedule_cards_as_new(card_ids)
        return
    except AttributeError:
        pass
    for c in note.cards():
        c.queue = 0
        c.type = 0
        c.ivl = 0
        c.due = getattr(col.sched, "today", 0)
        c.flush()


def _suspend_cards(note, col):
    card_ids = [c.id for c in note.cards()]
    if not card_ids:
        return
    try:
        col.sched.suspend_cards(card_ids)
        return
    except AttributeError:
        pass
    try:
        col.sched.suspendCards(card_ids)
        return
    except AttributeError:
        pass
    for c in note.cards():
        c.queue = -1
        c.flush()


def _apply_modify(action, cfg, col):
    note = col.get_note(action["nid"])
    for key, value in (action.get("fields") or {}).items():
        _set_field(note, key, value)
    col.update_note(note)
    if action.get("reset_scheduling"):
        _reset_scheduling(note, col)
    return {"modified_notes": 1, "created_notes": 0, "created_cards": 0, "new_note_ids": []}


def _apply_split(action, cfg, col, split_indices=None):
    note = col.get_note(action["nid"])
    model = _note_type(note)
    cards = list(note.cards())
    deck_id = getattr(cards[0], "did", None) if cards else None
    if deck_id is None:
        deck_id = 1

    new_notes = action.get("new_notes") or []
    if split_indices is None:
        target_items = [(i, item) for i, item in enumerate(new_notes)
                        if not item.get("applied") and not item.get("discarded")]
    else:
        target_items = []
        for i in split_indices:
            if 0 <= i < len(new_notes):
                item = new_notes[i]
                if not item.get("applied") and not item.get("discarded"):
                    target_items.append((i, item))

    new_note_ids = []
    for index, item in target_items:
        new_note = col.new_note(model)
        for key, value in (item.get("fields") or {}).items():
            _set_field(new_note, key, value)
        tags = list(item.get("tags") or [])
        if not tags:
            tags = list(note.tags or [])
        new_note.tags = tags
        col.add_note(new_note, deck_id)
        new_note_ids.append(new_note.id)
        item["applied"] = True
        item["discarded"] = False

    # 仅当所有新 note 都已 applied 或 discarded，才暂停原 note。
    if all(item.get("applied") or item.get("discarded") for item in new_notes):
        _suspend_cards(note, col)
        source_tag = cfg.get("source_tag")
        if source_tag:
            tags = list(note.tags or [])
            if source_tag not in tags:
                tags.append(source_tag)
                note.tags = tags
                col.update_note(note)

    tmpl_count = len(model.get("tmpls", []) or [])
    if tmpl_count <= 0:
        tmpl_count = 1
    return {
        "modified_notes": 0,
        "created_notes": len(new_note_ids),
        "created_cards": len(new_note_ids) * tmpl_count,
        "new_note_ids": new_note_ids,
    }


def apply_action(action, cfg, split_indices=None):
    from aqt import mw

    col = mw.col
    original = action.get("original") or {}
    if action["action"] == "modify":
        result = _apply_modify(action, cfg, col)
    elif action["action"] == "split":
        result = _apply_split(action, cfg, col, split_indices)
    else:
        raise ValueError("未知 action: %s" % action["action"])

    transaction_log.log_transaction(
        {
            "type": action["action"],
            "guid": action.get("guid"),
            "nid": action.get("nid"),
            "original_fields": original.get("fields"),
            "new_fields": action.get("fields"),
            "new_notes": action.get("new_notes"),
            "reason": action.get("reason"),
            "result": result,
        }
    )
    return result
