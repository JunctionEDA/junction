/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright (C) 2023 Mark Roszko <mark.roszko@gmail.com>
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#include <update_manager.h>
#include <pgm_base.h>

#include <string>
#include <sstream>

#include "settings/settings_manager.h"
#include "settings/kicad_settings.h"
#include <notifications_manager.h>

#include <kicad_curl/kicad_curl.h>
#include <kicad_curl/kicad_curl_easy.h>
#include <progress_reporter.h>

#include <dialogs/dialog_update_notice.h>

#include <json_common.h>
#include <core/json_serializers.h>

#include <wx/log.h>
#include <wx/event.h>
#include <wx/filefn.h>
#include <wx/translation.h>
#include <wx/notifmsg.h>

#include <background_jobs_monitor.h>

#include <thread_pool.h>

#include <build_version.h>


#include <collab/collab_product.h>

#include <algorithm>
#include <vector>


struct UPDATE_RESPONSE
{
    wxString version;
    wxString release_date;
    wxString details_url;
    wxString downloads_url;
};

NLOHMANN_DEFINE_TYPE_NON_INTRUSIVE( UPDATE_RESPONSE, version, release_date, details_url,
                                    downloads_url )

/*
 * Junction asks its own site for the newest desktop release instead of KiCad's update service,
 * which knows nothing about Junction.  The site reads the newest GitHub release; the answer names
 * the version and a /download/<platform> link that always serves that release's file.
 */
#define UPDATE_QUERY_ENDPOINT wxS( "https://junctioneda.com/api/desktop/latest" )


/// "2.10.1" -> {2, 10, 1}; anything after the numbers ("-rc1", "+abc") is ignored.
static std::vector<long> versionParts( const wxString& aVersion )
{
    std::vector<long> parts;
    wxString          v = aVersion;

    v.Trim( false ).Trim( true );

    if( v.StartsWith( wxS( "v" ) ) || v.StartsWith( wxS( "V" ) ) )
        v = v.Mid( 1 );

    long  cur = 0;
    bool  any = false;

    for( wxUniChar c : v )
    {
        if( c >= '0' && c <= '9' )
        {
            cur = cur * 10 + ( c - '0' );
            any = true;
        }
        else if( c == '.' && any )
        {
            parts.push_back( cur );
            cur = 0;
            any = false;
        }
        else
        {
            break;
        }
    }

    if( any )
        parts.push_back( cur );

    return parts;
}


/// True when aOffered is a later version than aCurrent.
bool UPDATE_MANAGER::IsNewerVersion( const wxString& aOffered, const wxString& aCurrent )
{
    std::vector<long> a = versionParts( aOffered );
    std::vector<long> b = versionParts( aCurrent );

    if( a.empty() )
        return false;

    size_t n = std::max( a.size(), b.size() );
    a.resize( n, 0 );
    b.resize( n, 0 );

    return a > b;
}


UPDATE_MANAGER::UPDATE_MANAGER() : m_working( false )
{
}


UPDATE_MANAGER::~UPDATE_MANAGER()
{
    if( m_updateBackgroundJob )
    {
        if( m_updateBackgroundJob->m_reporter )
            m_updateBackgroundJob->m_reporter->Cancel();

        if( m_updateTask.valid() )
            m_updateTask.wait();
    }
}


int UPDATE_MANAGER::PostRequest( const wxString& aUrl, std::string aRequestBody,
                                  std::ostream* aOutput, PROGRESS_REPORTER* aReporter,
                                  const size_t aSizeLimit )
{
    bool size_exceeded = false;

    TRANSFER_CALLBACK callback = [&]( size_t dltotal, size_t dlnow, size_t ultotal, size_t ulnow )
    {
        if( aSizeLimit > 0 && ( dltotal > aSizeLimit || dlnow > aSizeLimit ) )
        {
            size_exceeded = true;

            // Non zero return means abort.
            return true;
        }

        if( aReporter )
        {
            if( dltotal > 1000 )
            {
                aReporter->SetCurrentProgress( dlnow / (double) dltotal );
                aReporter->Report( wxString::Format( _( "Downloading %lld/%lld kB" ), dlnow / 1000,
                                                     dltotal / 1000 ) );
            }
            else
            {
                if( aReporter )
                    aReporter->SetCurrentProgress( 0.0 );
            }

            return !aReporter->KeepRefreshing();
        }
        else
            return false;
    };

    KICAD_CURL_EASY curl;
    curl.SetHeader( "Accept", "application/json" );
    curl.SetOutputStream( aOutput );
    curl.SetURL( aUrl.ToUTF8().data() );

    // An empty body makes a plain GET (Junction's endpoint); KiCad's POSTed JSON.
    if( !aRequestBody.empty() )
    {
        curl.SetHeader( "Content-Type", "application/json" );
        curl.SetHeader( "charset", "utf-8" );
        curl.SetPostFields( aRequestBody );
    }
    curl.SetFollowRedirects( true );
    curl.SetTransferCallback( callback, 250000L );
    curl.SetTimeout( 30L );

    int code = curl.Perform();

    if( aReporter && !aReporter->IsCancelled() )
        aReporter->SetCurrentProgress( 1.0 );

    if( code != CURLE_OK )
    {
        if( aReporter )
        {
            if( code == CURLE_ABORTED_BY_CALLBACK && size_exceeded )
                aReporter->Report( _( "Download is too large." ) );
            else if( code != CURLE_ABORTED_BY_CALLBACK )
                aReporter->Report( wxString( curl.GetErrorText( code ) ) );
        }

        return 0;
    }

    return curl.GetResponseStatusCode();
}


void UPDATE_MANAGER::CheckForUpdate( wxWindow* aNoticeParent )
{
    if( m_working.exchange( true ) )
        return;

    m_updateBackgroundJob = Pgm().GetBackgroundJobMonitor().Create( _( "Update Check" ) );

    auto update_check = [aNoticeParent, this]() -> void
    {
        std::shared_ptr<BACKGROUND_JOB_REPORTER> reporter = m_updateBackgroundJob->m_reporter;

        std::stringstream update_json_stream;

        reporter->SetNumPhases( 1 );
        reporter->Report( _( "Checking for a newer Junction" ) );

#if defined( __WXMSW__ )
        wxString platform = wxS( "windows" );
#elif defined( __WXOSX__ )
        wxString platform = wxS( "macos" );
#else
        wxString platform = wxS( "linux" );
#endif
        wxString aUrl = wxString( UPDATE_QUERY_ENDPOINT ) + wxS( "?platform=" ) + platform;

        KICAD_SETTINGS* settings = GetAppSettings<KICAD_SETTINGS>( "kicad" );

        int responseCode = PostRequest( aUrl, std::string(), &update_json_stream, reporter.get(),
                                        20480 );

        // Check that the response is 200 (content provided)
        if( responseCode == 200 && !Pgm().m_Quitting )
        {
            nlohmann::json  update_json;
            UPDATE_RESPONSE response;

            try
            {
                update_json_stream >> update_json;
                response = update_json.get<UPDATE_RESPONSE>();

                // Only a later release is offered, and one the person skipped is not offered again.
                if( IsNewerVersion( response.version, KICAD_COLLAB_PRODUCT_VERSION )
                    && response.version != settings->m_lastReceivedUpdate && !Pgm().m_Quitting )
                {
                    aNoticeParent->CallAfter(
                            [aNoticeParent, response]()
                            {
                                if( Pgm().m_Quitting )
                                    return;

                                auto notice = new DIALOG_UPDATE_NOTICE( aNoticeParent,
                                                                        response.version,
                                                                        response.details_url,
                                                                        response.downloads_url );

                                int retCode = notice->ShowModal();

                                if( retCode != wxID_RETRY )
                                {
                                    // basically saving the last received update prevents us from
                                    // prompting again
                                    if( KICAD_SETTINGS* cfg = GetAppSettings<KICAD_SETTINGS>( "kicad" ) )
                                        cfg->m_lastReceivedUpdate = response.version;
                                }
                            } );
                }
            }
            catch( const std::exception& e )
            {
                // A bad answer is not the person's problem: no error dialog, try again next start.
                wxLogTrace( wxS( "KICAD_UPDATE" ), wxS( "Unable to parse update response: %s" ),
                            e.what() );
            }
        }

        settings->m_lastUpdateCheckTime = wxDateTime::Now().FormatISOCombined();

        Pgm().GetBackgroundJobMonitor().Remove( m_updateBackgroundJob );
        m_updateBackgroundJob = nullptr;
        m_working = false;
    };

    thread_pool& tp = GetKiCadThreadPool();
    m_updateTask = tp.submit_task( update_check );
}
