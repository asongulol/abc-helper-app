'use client';

import type { CompanyContact } from '@/db/queries/config';
import { useId } from 'react';

interface ContactsEditorProps {
  contacts: CompanyContact[];
  onChange: (next: CompanyContact[]) => void;
}

/**
 * Shared controlled form fragment for editing a company's contacts. Holds no
 * state and makes no server calls — every edit is bubbled up via `onChange`
 * immutably. Reused by the employer and client editor cards.
 */
export const ContactsEditor = ({ contacts, onChange }: ContactsEditorProps) => {
  const baseId = useId();

  const updateContact = (index: number, patch: Partial<CompanyContact>) => {
    onChange(contacts.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const removeContact = (index: number) => {
    onChange(contacts.filter((_, i) => i !== index));
  };

  const addContact = () => {
    onChange([...contacts, {}]);
  };

  return (
    <div>
      <h4>Contacts</h4>

      {contacts.length === 0 ? (
        <p className="sub">No contacts yet.</p>
      ) : (
        contacts.map((contact, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: contacts have no stable id
          <div key={`${baseId}-${index}`} className="row">
            <div className="field">
              <label htmlFor={`${baseId}-${index}-first`}>First name</label>
              <input
                id={`${baseId}-${index}-first`}
                type="text"
                value={contact.first_name ?? ''}
                onChange={(e) => updateContact(index, { first_name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-${index}-last`}>Last name</label>
              <input
                id={`${baseId}-${index}-last`}
                type="text"
                value={contact.last_name ?? ''}
                onChange={(e) => updateContact(index, { last_name: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-${index}-title`}>Title</label>
              <input
                id={`${baseId}-${index}-title`}
                type="text"
                value={contact.title ?? ''}
                onChange={(e) => updateContact(index, { title: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-${index}-email`}>Email</label>
              <input
                id={`${baseId}-${index}-email`}
                type="email"
                value={contact.email ?? ''}
                onChange={(e) => updateContact(index, { email: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-${index}-mobile`}>Mobile</label>
              <input
                id={`${baseId}-${index}-mobile`}
                type="text"
                value={contact.mobile ?? ''}
                onChange={(e) => updateContact(index, { mobile: e.target.value })}
              />
            </div>
            <div className="field" style={{ minWidth: 80 }}>
              <label htmlFor={`${baseId}-${index}-ext`}>Ext.</label>
              <input
                id={`${baseId}-${index}-ext`}
                type="text"
                value={contact.extension ?? ''}
                onChange={(e) => updateContact(index, { extension: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`${baseId}-${index}-fax`}>Fax</label>
              <input
                id={`${baseId}-${index}-fax`}
                type="text"
                value={contact.fax ?? ''}
                onChange={(e) => updateContact(index, { fax: e.target.value })}
              />
            </div>
            <div className="field" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn danger-outline sm"
                onClick={() => removeContact(index)}
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}

      <button type="button" className="btn ghost sm" onClick={addContact}>
        + Add contact
      </button>
    </div>
  );
};
