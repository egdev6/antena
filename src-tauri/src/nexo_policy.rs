#[cfg(any(windows, test))]
use serde_json::Value;

pub fn hub_menu_items() -> &'static [(&'static str, &'static str)] {
    &[
        ("open", "Abrir el panel"),
        ("prompter", "Abrir el prompter"),
        ("dock", "Abrir el dock"),
        ("browser", "Abrir en el navegador"),
    ]
}

#[derive(Debug, PartialEq, Eq)]
pub enum TrayAction {
    Open,
    Prompter,
    Dock,
    Browser,
    Quit,
}

pub fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        "open" => Some(TrayAction::Open),
        "prompter" => Some(TrayAction::Prompter),
        "dock" => Some(TrayAction::Dock),
        "browser" => Some(TrayAction::Browser),
        "quit" => Some(TrayAction::Quit),
        _ => None,
    }
}

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
pub enum QuitDecision {
    Accept,
    Refuse(&'static str),
}

#[cfg(any(windows, test))]
pub fn quit_decision(persistence: Option<&Value>) -> QuitDecision {
    let values = |field| persistence
        .and_then(|value| value.get(field))
        .and_then(Value::as_object);
    let dirty = values("dirty").is_some_and(|entries| entries.values().any(|value| value.as_bool() == Some(true)));
    let pending = values("pending").is_some_and(|entries| entries.values().any(|value| value.as_u64().is_some_and(|count| count > 0)));
    if dirty || pending {
        QuitDecision::Refuse("Hay cambios sin guardar en antena; espera a que terminen de guardarse.")
    } else {
        QuitDecision::Accept
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hub_menu_has_the_existing_items_and_excludes_hub_quit() {
        let items = hub_menu_items();
        assert_eq!(items, &[
            ("open", "Abrir el panel"),
            ("prompter", "Abrir el prompter"),
            ("dock", "Abrir el dock"),
            ("browser", "Abrir en el navegador"),
        ]);
        assert!(items.len() <= 20);
        assert!(!items.iter().any(|(id, _)| *id == "quit"));
        for (i, (id, _)) in items.iter().enumerate() {
            assert!(!items[..i].iter().any(|(previous, _)| previous == id));
        }
    }

    #[test]
    fn tray_actions_preserve_all_native_routes_and_ignore_unknown_ids() {
        for (id, expected) in [
            ("open", Some(TrayAction::Open)),
            ("prompter", Some(TrayAction::Prompter)),
            ("dock", Some(TrayAction::Dock)),
            ("browser", Some(TrayAction::Browser)),
            ("quit", Some(TrayAction::Quit)),
            ("", None),
            ("Open", None),
            ("unknown", None),
        ] {
            assert_eq!(tray_action(id), expected, "{id}");
        }
    }

    #[test]
    fn quit_refuses_every_dirty_or_pending_persistence_kind() {
        const REASON: &str = "Hay cambios sin guardar en antena; espera a que terminen de guardarse.";
        for persistence in [
            json!({"dirty":{"config":true,"secrets":false},"pending":{"config":0,"secrets":0}}),
            json!({"dirty":{"config":false,"secrets":true},"pending":{"config":0,"secrets":0}}),
            json!({"dirty":{"other":true},"pending":{}}),
            json!({"dirty":{"config":false,"secrets":false},"pending":{"config":1,"secrets":0}}),
            json!({"dirty":{"config":false,"secrets":false},"pending":{"config":0,"secrets":2}}),
            json!({"dirty":{},"pending":{"other":1}}),
        ] {
            assert_eq!(quit_decision(Some(&persistence)), QuitDecision::Refuse(REASON), "{persistence}");
        }
    }

    #[test]
    fn quit_accepts_clean_or_unreadable_persistence() {
        for persistence in [
            json!({"dirty":{"config":false,"secrets":false},"pending":{"config":0,"secrets":0}}),
            json!({"dirty":{},"pending":{}}),
            json!(null),
        ] {
            assert_eq!(quit_decision(Some(&persistence)), QuitDecision::Accept, "{persistence}");
        }
        assert_eq!(quit_decision(None), QuitDecision::Accept);
    }
}
