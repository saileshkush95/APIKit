//! Credentials: obtaining them, and keeping them out of the database.
//!
//! `oauth` runs the OAuth 2.0 grants. `secrets` is the OS keychain, which is
//! where every token ends up — see the note there on why a credential must not
//! live beside the collection.

pub mod oauth;
pub mod secrets;
