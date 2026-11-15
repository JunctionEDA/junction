/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#ifndef COLLAB_PROPOSALS_H
#define COLLAB_PROPOSALS_H

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>
#include <math/box2.h>
#include <wx/string.h>

#include <collab/collab_cursor_item.h>

class EDA_BASE_FRAME;

/**
 * The changes an assistant proposed on the document an editor frame shows, for the person
 * to accept or reject -- the desktop side of the web editor's "Proposed changes" panel.
 *
 * An assistant working through the MCP server can park an edit instead of making it
 * (apply_changes with propose, propose_fixes).  The server keeps it, tells everyone in the
 * document, and nothing changes until a person with edit rights accepts it.  Here the
 * pending proposals of the current document show one at a time in the frame's infobar:
 *
 *     Ada's assistant proposes: Add decoupling to U3 (1 of 2)   Show  Details  Accept  Reject  Next
 *
 * Show draws what it would touch over the design (green new, amber changed, red removed)
 * and takes the view there.  Accept asks the server whether it still stands, settles it
 * there first (so two people cannot both apply it), then makes the edit through the
 * editor's own commit: one undo step, sent to the others like any local edit.  Reject
 * sends an optional reason back to the assistant.
 *
 * The editors differ only in what HOST gives; everything is called on the UI thread.
 */
class COLLAB_PROPOSALS
{
public:
    struct HOST
    {
        /// The server id of the document on display; empty when it is not a shared one.
        std::function<wxString()> docId;

        /// Internal units per millimetre of this editor.
        double iuPerMm = 1.0;

        /// Whether an item with this uuid is in the document on display.
        std::function<bool( const std::string& aId )> hasItem;

        /// Make the changes (the wire format of an op) as one local, undoable edit.
        /// False when they could not be made here.
        std::function<bool( const nlohmann::json& aChanges, const wxString& aMessage )> apply;

        /// Apply board rules a proposal carries (net class and minimums, millimetres).
        /// Unset where there are none to apply (schematics).
        std::function<void( const nlohmann::json& aRules )> applyRules;

        /// Draw the preview; two empty lists take it away.
        std::function<void( std::vector<PROPOSAL_BOX>&&, std::vector<REMOTE_GHOST_SEG>&& )>
                setPreview;

        /// Bring this area into view.
        std::function<void( const BOX2I& aArea )> focus;
    };

    COLLAB_PROPOSALS( EDA_BASE_FRAME* aFrame, HOST aHost );
    ~COLLAB_PROPOSALS();

    /// Ask the server for the pending proposals of the document on display: on joining,
    /// and whenever another sheet comes up.
    void Refresh();

    /// The server's "proposal" notice: one was added or decided.
    void OnNotice( const nlohmann::json& aMsg );

    /// The session ended or the document closed: forget everything and take the banner
    /// and the preview away.
    void Clear();

    /// Put the banner back after the person closed it (File > Proposed Changes).
    void ShowBanner();

    size_t Count() const { return m_pending.size(); }

private:
    void showBanner();
    void dismissBanner();
    void clearPreview();
    void forget( const std::string& aId );
    const nlohmann::json* current() const;

    void showPreview( const std::string& aId );
    void showDetails();
    void accept( const std::string& aId );
    void reject( const std::string& aId );

    /// PATCH the proposal on the worker, then run @p aThen on the UI thread with whether
    /// it took and, when not, why.
    void decide( const std::string& aId, const std::string& aStatus, const std::string& aReason,
                 std::function<void( bool aOk, int aHttpStatus, const wxString& aWhy )> aThen );

    EDA_BASE_FRAME*             m_frame;
    HOST                        m_host;
    std::shared_ptr<bool>       m_alive;
    std::vector<nlohmann::json> m_pending;      ///< oldest first, of m_docId
    wxString                    m_docId;        ///< the document m_pending belongs to
    size_t                      m_index = 0;
    std::string                 m_previewId;    ///< the proposal drawn on the canvas, if any
    bool                        m_bannerUp = false;
    bool                        m_busy = false; ///< a decision is on its way to the server
};

#endif // COLLAB_PROPOSALS_H
