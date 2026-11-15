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

#include <oauth/oauth_loopback_server.h>

#include <wx/tokenzr.h>
#include <wx/uri.h>
#include <wx/intl.h>


wxDEFINE_EVENT( EVT_OAUTH_LOOPBACK_RESULT, wxCommandEvent );


namespace
{
wxString queryValue( const wxString& aQuery, const wxString& aKey )
{
    wxStringTokenizer queryTokenizer( aQuery, wxS( "&" ) );

    while( queryTokenizer.HasMoreTokens() )
    {
        const wxString pair = queryTokenizer.GetNextToken();
        const int eqPos = pair.Find( '=' );

        if( eqPos == wxNOT_FOUND )
            continue;

        const wxString name = pair.Left( eqPos );
        const wxString value = pair.Mid( eqPos + 1 );

        if( name == aKey )
            return wxURI::Unescape( value );
    }

    return wxEmptyString;
}
} // namespace


OAUTH_LOOPBACK_SERVER::OAUTH_LOOPBACK_SERVER( wxEvtHandler* aOwner, const wxString& aCallbackPath,
                                              const wxString& aExpectedState ) :
        m_owner( aOwner ),
        m_callbackPath( aCallbackPath ),
        m_expectedState( aExpectedState ),
        m_port( 0 ),
        m_done( false )
{
    m_timeout.SetOwner( this );
    Bind( wxEVT_TIMER, &OAUTH_LOOPBACK_SERVER::OnTimeout, this, m_timeout.GetId() );
}


OAUTH_LOOPBACK_SERVER::~OAUTH_LOOPBACK_SERVER()
{
    m_timeout.Stop();
    Unbind( wxEVT_SOCKET, &OAUTH_LOOPBACK_SERVER::OnSocketEvent, this );
    Unbind( wxEVT_TIMER, &OAUTH_LOOPBACK_SERVER::OnTimeout, this, m_timeout.GetId() );
    Shutdown();
    m_timeout.SetOwner( nullptr );
}


bool OAUTH_LOOPBACK_SERVER::Start()
{
    wxIPV4address addr;
    addr.Hostname( wxS( "127.0.0.1" ) );
    addr.Service( 0 );

    std::unique_ptr<wxSocketServer> server =
            std::make_unique<wxSocketServer>( addr, wxSOCKET_REUSEADDR );

    if( !server->IsOk() )
        return false;

    server->SetEventHandler( *this );
    server->SetNotify( wxSOCKET_CONNECTION_FLAG );
    server->Notify( true );

    wxIPV4address local;
    server->GetLocal( local );
    m_port = local.Service();

    Bind( wxEVT_SOCKET, &OAUTH_LOOPBACK_SERVER::OnSocketEvent, this );

    m_server = std::move( server );
    // Generous: the browser leg can involve a provider login, 2FA and a consent
    // click before the code comes back.
    m_timeout.StartOnce( 300000 );
    return m_port != 0;
}


wxString OAUTH_LOOPBACK_SERVER::GetRedirectUri() const
{
    return wxString::Format( wxS( "http://127.0.0.1:%u%s" ), m_port, m_callbackPath );
}


bool OAUTH_LOOPBACK_SERVER::ParseAuthorizationResponse( const wxString& aRequestLine,
                                                        const wxString& aExpectedPath,
                                                        const wxString& aExpectedState,
                                                        OAUTH_AUTHORIZATION_RESPONSE& aResponse,
                                                        wxString& aError )
{
    aResponse = OAUTH_AUTHORIZATION_RESPONSE();
    aError.clear();

    wxStringTokenizer tokenizer( aRequestLine, wxS( " " ) );

    if( !tokenizer.HasMoreTokens() )
    {
        aError = _( "Missing HTTP method in callback request." );
        return false;
    }

    tokenizer.GetNextToken();

    if( !tokenizer.HasMoreTokens() )
    {
        aError = _( "Missing callback URL in request." );
        return false;
    }

    const wxString target = tokenizer.GetNextToken();
    const int queryPos = target.Find( '?' );
    const wxString path = queryPos == wxNOT_FOUND ? target : target.Left( queryPos );
    const wxString query = queryPos == wxNOT_FOUND ? wxString() : target.Mid( queryPos + 1 );

    if( path != aExpectedPath )
    {
        aError = _( "Unexpected callback path." );
        return false;
    }

    wxString state = queryValue( query, wxS( "state" ) );

    if( state != aExpectedState )
    {
        aError = _( "OAuth callback state did not match." );
        return false;
    }

    aResponse.state = state;
    aResponse.error = queryValue( query, wxS( "error" ) );
    aResponse.error_description = queryValue( query, wxS( "error_description" ) );

    if( !aResponse.error.IsEmpty() )
    {
        aError = _( "Authorization server returned an OAuth error." );
        return false;
    }

    aResponse.code = queryValue( query, wxS( "code" ) );

    if( aResponse.code.IsEmpty() )
    {
        aError = _( "Missing authorization code in callback." );
        return false;
    }

    return true;
}


void OAUTH_LOOPBACK_SERVER::OnSocketEvent( wxSocketEvent& aEvent )
{
    if( !m_server || aEvent.GetSocketEvent() != wxSOCKET_CONNECTION )
        return;

    std::unique_ptr<wxSocketBase> client( m_server->Accept( false ) );

    if( client )
        HandleClient( client.get() );
}


void OAUTH_LOOPBACK_SERVER::OnTimeout( wxTimerEvent& aEvent )
{
    wxUnusedVar( aEvent );
    Finish( false );
}


void OAUTH_LOOPBACK_SERVER::HandleClient( wxSocketBase* aClient )
{
    if( !aClient )
        return;

    aClient->SetTimeout( 5 );
    aClient->SetFlags( wxSOCKET_NONE );

    std::string request;
    request.reserve( 512 );
    char buffer[512];

    while( aClient->IsConnected() )
    {
        if( !aClient->WaitForRead( 1, 0 ) )
            break;

        aClient->Read( buffer, sizeof( buffer ) );
        const size_t count = aClient->LastCount();

        if( count == 0 )
            break;

        request.append( buffer, count );

        if( request.find( "\r\n\r\n" ) != std::string::npos || request.size() > 4096 )
            break;
    }

    const wxString requestWx = wxString::FromUTF8( request.data(), request.size() );
    const int endOfLine = requestWx.Find( wxS( "\r\n" ) );
    const wxString requestLine = endOfLine == wxNOT_FOUND ? requestWx : requestWx.Mid( 0, endOfLine );

    OAUTH_AUTHORIZATION_RESPONSE response;
    wxString error;
    const bool success = ParseAuthorizationResponse( requestLine, m_callbackPath, m_expectedState,
                                                     response, error );

    if( success )
        m_response = response;

    SendHttpResponse( aClient, success );
    Finish( success );
}


void OAUTH_LOOPBACK_SERVER::SendHttpResponse( wxSocketBase* aClient, bool aSuccess )
{
    if( !aClient )
        return;

    // One self-contained page in the site's look (palette and mark from server/static/theme.css
    // and icon.svg); it loads nothing from the network.  A tab opened by the system browser
    // usually may not close itself, so the page tries and otherwise says the tab can be closed.
    static const char* const page = R"html(<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>@TITLE@ - Junction</title>
<style>
:root { --bench:#f4f4f5; --paper:#fafafa; --panel:#fff; --ink:#111113; --ink-2:#52525b; --line:#e4e4e7;
        --dot:#d4d4d8; --accent:#111113; --accent-2:#27272a; --on-accent:#fafafa; --err:#b42318;
        --tile:#111113; --mark:#fafafa; }
@media (prefers-color-scheme: dark) {
:root { --bench:#111113; --paper:#18181b; --panel:#0b0b0c; --ink:#fafafa; --ink-2:#a1a1aa; --line:#27272a;
        --dot:#3f3f46; --accent:#fafafa; --accent-2:#e4e4e7; --on-accent:#0b0b0c; --err:#f97066;
        --tile:#fafafa; --mark:#111113; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: grid; place-items: center; padding: 16px; color: var(--ink); background-color: var(--paper);
       background-image: radial-gradient(var(--dot) 1px, transparent 1.3px); background-size: 20px 20px;
       font: 15px/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { width: 100%; max-width: 380px; padding: 32px 28px 28px; text-align: center; background: var(--panel);
       border: 1px solid var(--line); border-radius: 10px; }
svg { width: 52px; height: 52px; }
h1 { margin: 18px 0 6px; font-size: 20px; font-weight: 600; letter-spacing: -.01em; }
h1.bad { color: var(--err); }
p { margin: 0; color: var(--ink-2); }
button { margin-top: 22px; height: 36px; padding: 0 18px; border: 1px solid var(--accent-2); border-radius: 8px;
         background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 500; line-height: 1;
         cursor: pointer; }
button:hover { background: var(--accent-2); }
button:focus-visible { outline: 2px solid var(--ink-2); outline-offset: 2px; }
#hint { display: none; margin-top: 14px; font-size: 13px; }
</style></head><body><main>
<svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" rx="22" fill="var(--tile)"/>
<path d="M18 60H82M42 20V80" fill="none" stroke="var(--mark)" stroke-width="7" stroke-linecap="round"/>
<circle cx="42" cy="60" r="11" fill="var(--mark)"/></svg>
<h1 class="@CLASS@">@TITLE@</h1>
<p>@TEXT@</p>
<button type="button" id="close">Close this tab</button>
<p id="hint">Your browser keeps this tab open. You can close it yourself.</p>
</main><script>
(function () {
  var hint = document.getElementById("hint");
  function shut() { window.close(); setTimeout(function () { hint.style.display = "block"; }, 300); }
  document.getElementById("close").onclick = shut;
  if (@AUTOCLOSE@) setTimeout(function () { window.close(); }, 1500);
})();
</script></body></html>
)html";

    wxString body = wxString::FromUTF8( page );

    if( aSuccess )
    {
        body.Replace( wxS( "@TITLE@" ), wxS( "You're signed in" ) );
        body.Replace( wxS( "@CLASS@" ), wxS( "ok" ) );
        body.Replace( wxS( "@TEXT@" ), wxS( "Junction is connected to your account. Go back to the app to "
                                           "carry on." ) );
        body.Replace( wxS( "@AUTOCLOSE@" ), wxS( "true" ) );
    }
    else
    {
        body.Replace( wxS( "@TITLE@" ), wxS( "Sign-in didn't finish" ) );
        body.Replace( wxS( "@CLASS@" ), wxS( "bad" ) );
        body.Replace( wxS( "@TEXT@" ), wxS( "Junction could not complete the sign-in. Go back to the app "
                                           "and try again." ) );
        body.Replace( wxS( "@AUTOCLOSE@" ), wxS( "false" ) );
    }

    wxScopedCharBuffer bodyUtf8 = body.ToUTF8();

    wxString response;
    response << wxS( "HTTP/1.1 200 OK\r\n" )
             << wxS( "Content-Type: text/html; charset=utf-8\r\n" )
             << wxS( "Cache-Control: no-store\r\n" )
             << wxS( "Connection: close\r\n" )
             << wxS( "Content-Length: " ) << bodyUtf8.length() << wxS( "\r\n\r\n" );

    wxScopedCharBuffer header = response.ToUTF8();
    aClient->Write( header.data(), header.length() );
    aClient->Write( bodyUtf8.data(), bodyUtf8.length() );
    aClient->Close();
}


void OAUTH_LOOPBACK_SERVER::Finish( bool aSuccess )
{
    if( m_done )
        return;

    m_done = true;
    m_timeout.Stop();

    if( m_owner )
    {
        wxCommandEvent evt( EVT_OAUTH_LOOPBACK_RESULT );
        evt.SetInt( aSuccess ? 1 : 0 );

        if( aSuccess && m_response.has_value() )
            evt.SetString( m_response->code );

        wxQueueEvent( m_owner, evt.Clone() );
    }

    Shutdown();
}


void OAUTH_LOOPBACK_SERVER::Shutdown()
{
    if( m_server )
    {
        m_server->Notify( false );
        m_server.reset();
    }
}
