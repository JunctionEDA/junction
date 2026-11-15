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

#include <collab/collab_proposals.h>

#include <algorithm>
#include <optional>

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <confirm.h>
#include <dialogs/dialog_text_entry.h>
#include <eda_base_frame.h>
#include <math/util.h>
#include <widgets/wx_infobar.h>
#include <wx/app.h>
#include <wx/hyperlink.h>
#include <wx/intl.h>


namespace
{
std::string jsonString( const nlohmann::json& aObj, const char* aKey )
{
    return aObj.is_object() && aObj.contains( aKey ) && aObj[ aKey ].is_string()
                   ? aObj[ aKey ].get<std::string>()
                   : std::string();
}


/// "Ada's assistant (Claude)": whose assistant proposed it, and through which app.
wxString authorOf( const nlohmann::json& aProposal )
{
    wxString who;

    if( aProposal.contains( "by" ) && aProposal[ "by" ].is_object() )
    {
        who = wxString::FromUTF8( jsonString( aProposal[ "by" ], "name" ) );

        if( who.IsEmpty() )
            who = wxString::FromUTF8( jsonString( aProposal[ "by" ], "login" ) );
    }

    wxString author = who.IsEmpty() ? _( "An assistant" )
                                    : wxString::Format( _( "%s's assistant" ), who );
    wxString app = wxString::FromUTF8( jsonString( aProposal, "app" ) );

    if( !app.IsEmpty() )
        author += wxS( " (" ) + app + wxS( ")" );

    return author;
}


struct CREDENTIALS
{
    std::string server;
    std::string token;
};


CREDENTIALS credentials()
{
    wxString server = COLLAB_SESSION::ServerUrl();

    return { server.ToStdString( wxConvUTF8 ),
             COLLAB_AUTH::StoredToken( server ).ToStdString( wxConvUTF8 ) };
}
} // anonymous namespace


COLLAB_PROPOSALS::COLLAB_PROPOSALS( EDA_BASE_FRAME* aFrame, HOST aHost ) :
        m_frame( aFrame ),
        m_host( std::move( aHost ) ),
        m_alive( std::make_shared<bool>( true ) )
{
}


COLLAB_PROPOSALS::~COLLAB_PROPOSALS()
{
    *m_alive = false;
}


const nlohmann::json* COLLAB_PROPOSALS::current() const
{
    if( m_pending.empty() )
        return nullptr;

    return &m_pending[ std::min( m_index, m_pending.size() - 1 ) ];
}


void COLLAB_PROPOSALS::Refresh()
{
    wxString docId = m_host.docId ? m_host.docId() : wxString();

    if( docId != m_docId )
    {
        // Another document: what is on show belongs to the one we left.
        m_pending.clear();
        m_index = 0;
        clearPreview();
        dismissBanner();
        m_docId = docId;
    }

    if( docId.IsEmpty() )
        return;

    std::shared_ptr<bool> alive = m_alive;
    CREDENTIALS           cred = credentials();
    std::string           doc = docId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, cred, doc]()
            {
                std::optional<nlohmann::json> listing = COLLAB_REST::ListProposals(
                        wxString::FromUTF8( cred.server ), wxString::FromUTF8( cred.token ),
                        wxString::FromUTF8( doc ) );

                if( !listing || !listing->contains( "proposals" )
                    || !( *listing )[ "proposals" ].is_array() )
                {
                    return;
                }

                nlohmann::json rows = ( *listing )[ "proposals" ];

                wxTheApp->CallAfter(
                        [this, alive, rows, doc]()
                        {
                            if( !*alive || m_docId.ToStdString( wxConvUTF8 ) != doc )
                                return;

                            std::string shown = current() ? jsonString( *current(), "id" )
                                                          : std::string();

                            m_pending.clear();

                            // The server lists the newest first; people decide the oldest
                            // first, as later ones may build on it.
                            for( auto it = rows.rbegin(); it != rows.rend(); ++it )
                            {
                                if( it->is_object() && jsonString( *it, "status" ) == "pending" )
                                    m_pending.push_back( *it );
                            }

                            m_index = 0;

                            for( size_t ii = 0; ii < m_pending.size(); ++ii )
                            {
                                if( jsonString( m_pending[ii], "id" ) == shown )
                                    m_index = ii;
                            }

                            bool previewStands = std::any_of(
                                    m_pending.begin(), m_pending.end(),
                                    [this]( const nlohmann::json& aRow )
                                    {
                                        return jsonString( aRow, "id" ) == m_previewId;
                                    } );

                            if( !previewStands )
                                clearPreview();

                            if( m_pending.empty() )
                                dismissBanner();
                            else
                                showBanner();
                        } );
            } );
}


void COLLAB_PROPOSALS::OnNotice( const nlohmann::json& aMsg )
{
    if( !aMsg.is_object() || !aMsg.contains( "proposal" ) || !aMsg[ "proposal" ].is_object() )
        return;

    const nlohmann::json& proposal = aMsg[ "proposal" ];
    std::string           id = jsonString( proposal, "id" );
    std::string           action = jsonString( aMsg, "action" );

    if( id.empty() || wxString::FromUTF8( jsonString( aMsg, "docId" ) ) != m_docId
        || m_docId.IsEmpty() )
    {
        return;
    }

    if( action == "added" && jsonString( proposal, "status" ) == "pending" )
    {
        bool known = std::any_of( m_pending.begin(), m_pending.end(),
                                  [&]( const nlohmann::json& aRow )
                                  {
                                      return jsonString( aRow, "id" ) == id;
                                  } );

        if( !known )
            m_pending.push_back( proposal );

        showBanner();
    }
    else if( action == "decided" )
    {
        forget( id );
    }
}


void COLLAB_PROPOSALS::forget( const std::string& aId )
{
    size_t before = m_pending.size();

    m_pending.erase( std::remove_if( m_pending.begin(), m_pending.end(),
                                     [&]( const nlohmann::json& aRow )
                                     {
                                         return jsonString( aRow, "id" ) == aId;
                                     } ),
                     m_pending.end() );

    if( m_previewId == aId )
        clearPreview();

    if( m_pending.size() == before )
        return;

    if( m_index >= m_pending.size() )
        m_index = 0;

    if( m_pending.empty() )
        dismissBanner();
    else if( m_bannerUp )
        showBanner();
}


void COLLAB_PROPOSALS::Clear()
{
    m_pending.clear();
    m_index = 0;
    m_docId.clear();
    clearPreview();
    dismissBanner();
}


void COLLAB_PROPOSALS::ShowBanner()
{
    if( m_pending.empty() )
    {
        m_frame->ShowInfoBarMsg( _( "No changes are proposed on this document." ), true );
        Refresh();
        return;
    }

    showBanner();
}


void COLLAB_PROPOSALS::clearPreview()
{
    if( m_previewId.empty() )
        return;

    m_previewId.clear();

    if( m_host.setPreview )
        m_host.setPreview( {}, {} );
}


void COLLAB_PROPOSALS::dismissBanner()
{
    if( !m_bannerUp )
        return;

    m_bannerUp = false;

    if( WX_INFOBAR* infoBar = m_frame->GetInfoBar() )
    {
        infoBar->RemoveAllButtons();
        infoBar->Dismiss();
    }
}


void COLLAB_PROPOSALS::showBanner()
{
    const nlohmann::json* proposal = current();
    WX_INFOBAR*           infoBar = m_frame->GetInfoBar();

    if( !proposal || !infoBar )
        return;

    m_index = std::min( m_index, m_pending.size() - 1 );

    std::string           id = jsonString( *proposal, "id" );
    std::shared_ptr<bool> alive = m_alive;

    // A link's handler runs inside the infobar's own event, and every one of these ends
    // up rebuilding the infobar: do the work once that event has returned.
    auto later = [alive]( std::function<void()> aWork )
    {
        return [alive, aWork]( wxHyperlinkEvent& )
        {
            wxTheApp->CallAfter(
                    [alive, aWork]()
                    {
                        if( *alive )
                            aWork();
                    } );
        };
    };

    infoBar->RemoveAllButtons();

    if( m_previewId == id )
        infoBar->AddLink( _( "Hide" ), later( [this]() { clearPreview(); showBanner(); } ) );
    else
        infoBar->AddLink( _( "Show" ), later( [this, id]() { showPreview( id ); } ) );

    infoBar->AddLink( _( "Details" ), later( [this]() { showDetails(); } ) );
    infoBar->AddLink( _( "Accept" ), later( [this, id]() { accept( id ); } ) );
    infoBar->AddLink( _( "Reject" ), later( [this, id]() { reject( id ); } ) );

    if( m_pending.size() > 1 )
    {
        infoBar->AddLink( _( "Next" ), later( [this]()
                                              {
                                                  if( m_pending.empty() )
                                                      return;

                                                  m_index = ( m_index + 1 ) % m_pending.size();
                                                  clearPreview();
                                                  showBanner();
                                              } ) );
    }

    infoBar->AddCloseButton();

    wxString message = wxString::Format( _( "%s proposes: %s" ), authorOf( *proposal ),
                                         wxString::FromUTF8( jsonString( *proposal, "title" ) ) );

    if( m_pending.size() > 1 )
    {
        message += wxS( " " ) + wxString::Format( _( "(%d of %d)" ), (int) m_index + 1,
                                                  (int) m_pending.size() );
    }

    infoBar->ShowMessage( message, wxICON_INFORMATION );
    m_bannerUp = true;
}


void COLLAB_PROPOSALS::showDetails()
{
    const nlohmann::json* proposal = current();

    if( !proposal )
        return;

    wxString text;
    wxString rationale = wxString::FromUTF8( jsonString( *proposal, "rationale" ) );

    if( !rationale.IsEmpty() )
        text += rationale + wxS( "\n\n" );

    if( proposal->contains( "lines" ) && ( *proposal )[ "lines" ].is_array() )
    {
        for( const nlohmann::json& line : ( *proposal )[ "lines" ] )
        {
            std::string kind = jsonString( line, "kind" );

            text += kind == "add" ? wxS( "+ " ) : kind == "remove" ? wxS( "- " ) : wxS( "~ " );
            text += wxString::FromUTF8( jsonString( line, "text" ) ) + wxS( "\n" );
        }
    }

    if( proposal->contains( "connectivity" ) && ( *proposal )[ "connectivity" ].is_array() )
    {
        text += wxS( "\n" );

        for( const nlohmann::json& line : ( *proposal )[ "connectivity" ] )
        {
            if( line.is_string() )
                text += wxString::FromUTF8( line.get<std::string>() ) + wxS( "\n" );
        }
    }

    if( proposal->contains( "rules" ) && ( *proposal )[ "rules" ].is_boolean()
        && ( *proposal )[ "rules" ].get<bool>() )
    {
        text += wxS( "\n" ) + _( "Also changes the board rules of the project." ) + wxS( "\n" );
    }

    DisplayInfoMessage( m_frame,
                        wxString::Format( _( "%s proposes: %s" ), authorOf( *proposal ),
                                          wxString::FromUTF8( jsonString( *proposal, "title" ) ) ),
                        text );
}


void COLLAB_PROPOSALS::showPreview( const std::string& aId )
{
    std::shared_ptr<bool> alive = m_alive;
    CREDENTIALS           cred = credentials();

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, cred, aId]()
            {
                COLLAB_REST::ERROR_INFO       error;
                std::optional<nlohmann::json> found = COLLAB_REST::GetProposal(
                        wxString::FromUTF8( cred.server ), wxString::FromUTF8( cred.token ),
                        wxString::FromUTF8( aId ), &error );

                nlohmann::json proposal = found ? *found : nlohmann::json();
                std::string    why = COLLAB_REST::DescribeError( error ).ToStdString( wxConvUTF8 );

                wxTheApp->CallAfter(
                        [this, alive, proposal, why, aId]()
                        {
                            if( !*alive )
                                return;

                            if( !proposal.is_object() )
                            {
                                DisplayErrorMessage( m_frame,
                                                     _( "The proposed change could not be read." ),
                                                     wxString::FromUTF8( why ) );
                                return;
                            }

                            std::vector<PROPOSAL_BOX>     boxes;
                            std::vector<REMOTE_GHOST_SEG> segs;
                            BOX2I                         area;
                            bool                          any = false;
                            const double                  iu = m_host.iuPerMm;

                            auto at = [iu]( const nlohmann::json& aRow, size_t aIdx )
                            {
                                return KiROUND( aRow[ aIdx ].get<double>() * iu );
                            };

                            auto numbers = []( const nlohmann::json& aRow, size_t aCount )
                            {
                                if( !aRow.is_array() || aRow.size() < aCount )
                                    return false;

                                for( size_t ii = 0; ii < aCount; ++ii )
                                {
                                    if( !aRow[ ii ].is_number() )
                                        return false;
                                }

                                return true;
                            };

                            const nlohmann::json preview =
                                    proposal.contains( "body" ) && proposal[ "body" ].is_object()
                                    && proposal[ "body" ].contains( "preview" )
                                            ? proposal[ "body" ][ "preview" ]
                                            : nlohmann::json();

                            if( preview.is_object() && preview.contains( "boxes" )
                                && preview[ "boxes" ].is_array() )
                            {
                                for( const nlohmann::json& row : preview[ "boxes" ] )
                                {
                                    if( !numbers( row, 4 ) )
                                        continue;

                                    PROPOSAL_BOX entry;
                                    VECTOR2I     a( at( row, 0 ), at( row, 1 ) );
                                    VECTOR2I     b( at( row, 2 ), at( row, 3 ) );

                                    entry.box = BOX2I( a, b - a );
                                    entry.box.Normalize();

                                    std::string kind = row.size() > 4 && row[ 4 ].is_string()
                                                               ? row[ 4 ].get<std::string>()
                                                               : std::string();

                                    entry.kind = kind == "add"      ? PROPOSAL_BOX::ADD
                                                 : kind == "remove" ? PROPOSAL_BOX::REMOVE
                                                                    : PROPOSAL_BOX::MODIFY;

                                    if( any )
                                        area.Merge( entry.box );
                                    else
                                        area = entry.box;

                                    any = true;
                                    boxes.push_back( entry );
                                }
                            }

                            if( preview.is_object() && preview.contains( "segs" )
                                && preview[ "segs" ].is_array() )
                            {
                                for( const nlohmann::json& row : preview[ "segs" ] )
                                {
                                    if( !numbers( row, 4 ) )
                                        continue;

                                    REMOTE_GHOST_SEG seg;
                                    seg.a = VECTOR2I( at( row, 0 ), at( row, 1 ) );
                                    seg.b = VECTOR2I( at( row, 2 ), at( row, 3 ) );
                                    seg.width = row.size() > 4 && row[ 4 ].is_number() ? at( row, 4 )
                                                                                      : 0;
                                    segs.push_back( seg );
                                }
                            }

                            if( !any )
                            {
                                m_frame->ShowInfoBarMsg( _( "This proposal has nothing to draw; "
                                                            "see Details for what it changes." ),
                                                         true );
                                m_bannerUp = false;
                                return;
                            }

                            m_previewId = aId;

                            if( m_host.setPreview )
                                m_host.setPreview( std::move( boxes ), std::move( segs ) );

                            if( m_host.focus )
                                m_host.focus( area );

                            showBanner();
                        } );
            } );
}


void COLLAB_PROPOSALS::decide( const std::string& aId, const std::string& aStatus,
                               const std::string& aReason,
                               std::function<void( bool, int, const wxString& )> aThen )
{
    std::shared_ptr<bool> alive = m_alive;
    CREDENTIALS           cred = credentials();

    COLLAB_SESSION::Get().RunAsync(
            [alive, cred, aId, aStatus, aReason, aThen]()
            {
                COLLAB_REST::ERROR_INFO       error;
                std::optional<nlohmann::json> done = COLLAB_REST::DecideProposal(
                        wxString::FromUTF8( cred.server ), wxString::FromUTF8( cred.token ),
                        wxString::FromUTF8( aId ), wxString::FromUTF8( aStatus ),
                        wxString::FromUTF8( aReason ), &error );

                bool        ok = done.has_value();
                int         status = error.status;
                std::string why = COLLAB_REST::DescribeError( error ).ToStdString( wxConvUTF8 );

                wxTheApp->CallAfter(
                        [alive, aThen, ok, status, why]()
                        {
                            if( *alive )
                                aThen( ok, status, wxString::FromUTF8( why ) );
                        } );
            } );
}


void COLLAB_PROPOSALS::accept( const std::string& aId )
{
    if( m_busy )
        return;

    m_busy = true;

    std::shared_ptr<bool> alive = m_alive;
    CREDENTIALS           cred = credentials();

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, cred, aId]()
            {
                COLLAB_REST::ERROR_INFO       error;
                std::optional<nlohmann::json> found = COLLAB_REST::GetProposal(
                        wxString::FromUTF8( cred.server ), wxString::FromUTF8( cred.token ),
                        wxString::FromUTF8( aId ), &error );

                nlohmann::json proposal = found ? *found : nlohmann::json();
                std::string    why = COLLAB_REST::DescribeError( error ).ToStdString( wxConvUTF8 );

                wxTheApp->CallAfter(
                        [this, alive, proposal, why, aId]()
                        {
                            if( !*alive )
                                return;

                            m_busy = false;

                            if( !proposal.is_object() )
                            {
                                DisplayErrorMessage( m_frame,
                                                     _( "The proposed change could not be read." ),
                                                     wxString::FromUTF8( why ) );
                                return;
                            }

                            if( jsonString( proposal, "status" ) != "pending" )
                            {
                                forget( aId );
                                m_frame->ShowInfoBarMsg( _( "That proposal has already been "
                                                            "decided." ), true );
                                m_bannerUp = false;
                                return;
                            }

                            if( wxString::FromUTF8( jsonString( proposal, "docId" ) ) != m_docId )
                                return;

                            const nlohmann::json body = proposal.contains( "body" )
                                                                ? proposal[ "body" ]
                                                                : nlohmann::json();
                            const nlohmann::json changes =
                                    body.is_object() && body.contains( "changes" )
                                    && body[ "changes" ].is_array()
                                            ? body[ "changes" ]
                                            : nlohmann::json::array();
                            const nlohmann::json rules =
                                    body.is_object() && body.contains( "rules" )
                                    && body[ "rules" ].is_object()
                                            ? body[ "rules" ]
                                            : nlohmann::json();

                            // Does it still fit the design?  The server knows whether an
                            // item it changes was edited since; here, an item it adds must
                            // not exist yet and one it changes or removes still must.
                            bool stale = proposal.contains( "stale" )
                                         && proposal[ "stale" ].is_string();

                            if( m_host.hasItem )
                            {
                                for( const nlohmann::json& change : changes )
                                {
                                    if( !change.is_object() )
                                        continue;

                                    std::string kind = jsonString( change, "kind" );
                                    bool        here = m_host.hasItem( jsonString( change, "id" ) );

                                    if( ( kind == "ADDED" && here ) || ( kind != "ADDED" && !here ) )
                                        stale = true;
                                }
                            }

                            if( stale )
                            {
                                decide( aId, "stale", "", []( bool, int, const wxString& ) {} );
                                forget( aId );
                                DisplayInfoMessage(
                                        m_frame,
                                        _( "The design has changed since this was proposed, so "
                                           "it was set aside instead of applied." ),
                                        _( "Ask the assistant to propose it again on the design "
                                           "as it is now." ) );
                                return;
                            }

                            wxString title = wxString::FromUTF8( jsonString( proposal, "title" ) );

                            m_busy = true;

                            // Settled on the server first: of two people who press Accept,
                            // one is told the other was faster, and it is applied once.
                            decide( aId, "accepted", "",
                                    [this, aId, changes, rules, title]( bool aOk, int aStatus,
                                                                        const wxString& aWhy )
                                    {
                                        m_busy = false;

                                        if( !aOk )
                                        {
                                            if( aStatus == 409 )
                                            {
                                                forget( aId );
                                                m_frame->ShowInfoBarMsg(
                                                        _( "Someone else decided that proposal "
                                                           "first." ), true );
                                                m_bannerUp = false;
                                            }
                                            else
                                            {
                                                DisplayErrorMessage(
                                                        m_frame,
                                                        _( "The proposal could not be accepted." ),
                                                        aWhy );
                                            }

                                            return;
                                        }

                                        forget( aId );

                                        if( rules.is_object() && m_host.applyRules )
                                            m_host.applyRules( rules );

                                        bool made = changes.empty()
                                                    || ( m_host.apply
                                                         && m_host.apply(
                                                                 changes,
                                                                 wxString::Format( _( "AI: %s" ),
                                                                                   title ) ) );

                                        if( !made )
                                        {
                                            DisplayErrorMessage(
                                                    m_frame,
                                                    _( "The proposal was accepted but its changes "
                                                       "could not be made here." ),
                                                    _( "Ask the assistant to make the change "
                                                       "again." ) );
                                        }
                                    } );
                        } );
            } );
}


void COLLAB_PROPOSALS::reject( const std::string& aId )
{
    if( m_busy )
        return;

    WX_TEXT_ENTRY_DIALOG dlg( m_frame, _( "Reason, sent back to the assistant (optional):" ),
                              _( "Reject Proposed Change" ) );

    if( dlg.ShowModal() != wxID_OK )
        return;

    std::string reason = dlg.GetValue().Trim().Trim( false ).ToStdString( wxConvUTF8 );

    m_busy = true;

    decide( aId, "rejected", reason,
            [this, aId]( bool aOk, int aStatus, const wxString& aWhy )
            {
                m_busy = false;

                if( aOk || aStatus == 409 )
                {
                    forget( aId );
                    return;
                }

                DisplayErrorMessage( m_frame, _( "The proposal could not be rejected." ), aWhy );
            } );
}
