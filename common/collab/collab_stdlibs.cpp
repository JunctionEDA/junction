/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <collab/collab_stdlibs.h>

#include <algorithm>
#include <atomic>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

#include <wx/dir.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/intl.h>
#include <wx/uri.h>
#include <wx/time.h>
#include <wx/utils.h>
#include <wx/wfstream.h>
#include <wx/zipstrm.h>

#include <collab/collab_session.h>
#include <kicad_curl/kicad_curl_easy.h>
#include <nlohmann/json.hpp>
#include <picosha2.h>
#include <libraries/library_manager.h>
#include <libraries/library_table.h>
#include <paths.h>
#include <pgm_base.h>
#include <settings/common_settings.h>
#include <settings/environment.h>


namespace
{

struct ARCHIVE
{
    const char* repository;     ///< under gitlab.com/kicad/libraries
    const char* folder;         ///< where its libraries go, beside the other kinds
    const char* librarySuffix;  ///< what a library folder's name ends in
    const char* table;          ///< the library table at the top of the repository
};

// In the order they are downloaded: the footprints and symbols, which a design cannot do
// without, before the project templates and drawing sheets.  (Putting them in place has its
// own order, with the symbols folder last: it is what marks the set as installed.)
const ARCHIVE ARCHIVES[] = {
    { "kicad-footprints", "footprints", ".pretty", "fp-lib-table" },
    { "kicad-symbols", "symbols", ".kicad_symdir", "sym-lib-table" },
    { "kicad-templates", "templates", "", "" },
};


wxString libraryRef()
{
    wxString ref;

    if( wxGetEnv( wxS( "JUNCTION_LIBRARIES_REF" ), &ref ) && !ref.IsEmpty() )
        return ref;

    // The release the collaboration server keeps too (KC_LIBS_REF there).
    return wxS( "10.0.8" );
}


wxString declinedMarker()
{
    return wxFileName( PATHS::GetUserSettingsPath(), wxS( "junction-standard-libraries-declined" ) )
            .GetFullPath();
}


wxString downloadFolder()
{
    return PATHS::GetManagedLibrariesPath() + wxFileName::GetPathSeparator() + wxS( "download" );
}


bool removeDir( const wxString& aDir )
{
    return !wxFileName::DirExists( aDir ) || wxFileName::Rmdir( aDir, wxPATH_RMDIR_RECURSIVE );
}


/// Set while the download waits before another try, and to cut that wait short.
std::atomic<bool> s_waiting( false );
std::atomic<bool> s_retryNow( false );

/// Set while Install() runs, with how far it is.
std::atomic<bool> s_running( false );
std::atomic<int>  s_percent( 0 );

/// Set when the program closes during a download: the stop that follows is not the user's
/// "no", so the download continues at the next start.
std::atomic<bool> s_suspended( false );

/// Where the standard libraries were looked for before a download put them in place.
std::mutex            s_formerMutex;
std::vector<wxString> s_formerDirs;

/// For the progress text of the running Install(): the size of all the archives together when
/// the server told it (0 when unknown), and the bytes of the archives that are complete.
std::atomic<long long> s_allBytes( 0 );
std::atomic<long long> s_doneBytes( 0 );


/// "about 40 s", "about 3 min": how long a download still takes, for the progress text.
wxString timeLeft( double aSeconds )
{
    if( aSeconds < 90 )
        return wxString::Format( _( "about %d s left" ), std::max( 1, (int) ( aSeconds + 0.5 ) ) );

    if( aSeconds < 5400 )
        return wxString::Format( _( "about %d min left" ), (int) ( aSeconds / 60 + 0.5 ) );

    return wxString::Format( _( "about %d h left" ), (int) ( aSeconds / 3600 + 0.5 ) );
}


wxString stoppedMessage()
{
    return _( "The download was stopped." );
}


wxFileOffset fileSize( const wxString& aFile )
{
    return wxFileName::FileExists( aFile ) ? (wxFileOffset) wxFileName::GetSize( aFile ).GetValue() : 0;
}


/// Append one file to another.
bool appendFile( const wxString& aFrom, const wxString& aTo )
{
    wxFFileInputStream  in( aFrom );
    wxFFileOutputStream out( aTo, wxS( "ab" ) );

    if( !in.IsOk() || !out.IsOk() )
        return false;

    in.Read( out );
    return out.IsOk() && out.Close();
}


/// Where one archive is fetched from.
struct SOURCE
{
    wxString    url;
    wxString    host;           ///< for messages
    wxString    file;           ///< its name in the download folder
    long long   size = -1;      ///< -1 when the source does not say
    std::string sha256;         ///< empty when the source does not say
};


/// The archive at the KiCad library repositories.  Its server ignores Range, so a download
/// that was cut short starts that archive again.
SOURCE gitlabSource( const ARCHIVE& aArchive, const wxString& aRef )
{
    const wxString ref = aRef.IsEmpty() ? libraryRef() : aRef;
    SOURCE         source;

    source.url = wxString::Format(
            wxS( "https://gitlab.com/kicad/libraries/%s/-/archive/%s/%s-%s.zip" ),
            aArchive.repository, ref, aArchive.repository, ref );
    source.host = wxS( "gitlab.com" );
    source.file = wxString::Format( wxS( "%s-%s.zip" ), aArchive.repository, ref );
    return source;
}


/**
 * The archives the collaboration server keeps: the same library release, served with byte
 * ranges (a download continues in the middle of a file) and with size and SHA-256.
 *
 * @return by archive folder name; empty when the server cannot be reached or has none.
 */
std::map<wxString, SOURCE> serverSources( wxString* aRef )
{
    std::map<wxString, SOURCE> sources;

    if( wxGetEnv( wxS( "JUNCTION_LIBRARIES_REF" ), nullptr )
        || wxGetEnv( wxS( "JUNCTION_LIBRARIES_FROM_GITLAB" ), nullptr ) )
    {
        return sources;     // a particular upstream ref was asked for
    }

    try
    {
        wxString server = COLLAB_SESSION::ServerUrl();

        while( server.EndsWith( wxS( "/" ) ) )
            server.RemoveLast();

        if( server.IsEmpty() )
            return sources;

        KICAD_CURL_EASY curl;

        curl.SetURL( ( server + wxS( "/api/libs/archive" ) ).ToStdString( wxConvUTF8 ) );
        curl.SetUserAgent( "junction-libraries/1" );
        curl.SetFollowRedirects( true );
        curl.SetConnectTimeout( 10 );
        curl.SetTimeout( 120 );     // the first request after a deploy makes the server fetch them

        if( curl.Perform() != 0 || curl.GetResponseStatusCode() != 200 )
            return sources;

        const nlohmann::json manifest = nlohmann::json::parse( curl.GetBuffer() );
        const std::string    ref = manifest.value( "ref", std::string() );

        for( const nlohmann::json& entry : manifest.at( "archives" ) )
        {
            const std::string kind = entry.value( "kind", std::string() );
            const std::string url = entry.value( "url", std::string() );
            SOURCE            source;

            source.size = entry.value( "size", -1LL );
            source.sha256 = entry.value( "sha256", std::string() );

            if( kind.empty() || url.empty() || ref.empty() || source.size <= 0
                || source.sha256.size() != 64 )
            {
                continue;
            }

            source.url = server + wxString::FromUTF8( url );
            source.host = wxURI( server ).GetServer();
            source.file = wxString::Format( wxS( "junction-%s-%s.zip" ), wxString::FromUTF8( kind ),
                                            wxString::FromUTF8( ref ) );
            sources[wxString::FromUTF8( kind )] = source;
        }

        if( !sources.empty() )
            *aRef = wxString::FromUTF8( ref );
    }
    catch( ... )
    {
        sources.clear();
    }

    return sources;
}


/// @return the SHA-256 of a file as lower-case hex, or an empty string.
std::string sha256Of( const wxString& aFile )
{
    std::ifstream in( aFile.fn_str(), std::ios::binary );

    if( !in.is_open() )
        return std::string();

    picosha2::hash256_one_by_one hasher;
    std::vector<unsigned char>   buffer( 1 << 20 );

    hasher.init();

    while( in )
    {
        in.read( reinterpret_cast<char*>( buffer.data() ), buffer.size() );

        const std::streamsize got = in.gcount();

        if( got > 0 )
            hasher.process( buffer.begin(), buffer.begin() + got );
    }

    hasher.finish();

    std::vector<unsigned char> digest( picosha2::k_digest_size );
    hasher.get_hash_bytes( digest.begin(), digest.end() );
    return picosha2::bytes_to_hex_string( digest.begin(), digest.end() );
}


/**
 * One attempt at one repository archive.  What an earlier attempt (or an earlier run of the
 * program) already fetched stays in "<target>.part"; the server is asked for the rest, and
 * when it sends the whole file anyway the part is replaced.
 *
 * @return an empty string once "<target>" is complete, or what went wrong.
 */
wxString downloadOnce( const ARCHIVE& aArchive, const SOURCE& aSource, const wxString& aTarget,
                       const COLLAB_STDLIBS::PROGRESS& aProgress, int aStep, bool* aDamaged )
{
    *aDamaged = false;

    const wxString& url = aSource.url;
    const wxString  part = aTarget + wxS( ".part" );
    const wxString  piece = aTarget + wxS( ".piece" );

    // Checked against what the source says about the file, when it says anything.
    auto finish =
            [&]() -> wxString
            {
                const wxFileOffset got = fileSize( part );

                if( aSource.size >= 0 && got < aSource.size )
                {
                    return wxString::Format( _( "The connection to %s closed before the %s "
                                                "were complete." ),
                                             aSource.host, wxString( aArchive.folder ) );
                }

                if( ( aSource.size >= 0 && got > aSource.size )
                    || ( !aSource.sha256.empty() && sha256Of( part ) != aSource.sha256 ) )
                {
                    wxRemoveFile( part );
                    *aDamaged = true;
                    return wxString::Format( _( "The %s arrived damaged from %s." ),
                                             wxString( aArchive.folder ), aSource.host );
                }

                if( !wxRenameFile( part, aTarget, true ) )
                    return wxString::Format( _( "Cannot write '%s'." ), aTarget );

                return wxEmptyString;
            };

    // A program that was closed (or died) in the middle of an attempt leaves what it had
    // fetched in the piece.  With no part beside it the piece began at the start of the file
    // and becomes the part; beside a part it may be either a continuation or a new start, so
    // it is dropped.
    if( wxFileExists( piece ) )
    {
        if( !wxFileExists( part ) && fileSize( piece ) > 0 )
            wxRenameFile( piece, part, true );
        else
            wxRemoveFile( piece );
    }

    const wxFileOffset have = fileSize( part );

    // Everything is here already (the program was closed just before the last step).
    if( aSource.size >= 0 && have >= aSource.size )
        return finish();

    std::ofstream out( piece.fn_str(), std::ios::binary | std::ios::trunc );

    if( !out.is_open() )
        return wxString::Format( _( "Cannot write '%s'." ), piece );

    bool       stopped = false;
    bool       stalled = false;
    size_t     lastNow = 0;
    wxLongLong lastMoved = wxGetLocalTimeMillis();

    // For the estimate of the time left: when data started to arrive in this attempt.
    wxLongLong firstData = 0;

    KICAD_CURL_EASY curl;

    curl.SetURL( url.ToStdString( wxConvUTF8 ) );
    curl.SetUserAgent( "junction-libraries/1" );
    curl.SetFollowRedirects( true );
    curl.SetConnectTimeout( 15 );
    curl.SetOutputStream( &out );

    if( have > 0 )
        curl.SetHeader( "Range", wxString::Format( wxS( "bytes=%lld-" ), (long long) have ).ToStdString() );

    curl.SetTransferCallback(
            [&]( size_t aTotal, size_t aNow, size_t, size_t ) -> int
            {
                // A connection that went quiet is given up, so the next attempt can start.
                if( aNow != lastNow )
                {
                    lastNow = aNow;
                    lastMoved = wxGetLocalTimeMillis();
                }
                else if( wxGetLocalTimeMillis() - lastMoved > 30000 )
                {
                    stalled = true;
                    return 1;
                }

                // What is downloading, how much of how much, and how long it still takes:
                // "Downloading symbols: 21 of 61 MB, about 40 s left".  The sizes are those of
                // all three archives when the server told them, of this one otherwise.
                const double mb = 1048576.0;
                const long long fileTotal = aSource.size > 0 ? (long long) aSource.size
                                            : aTotal > 0     ? (long long) ( have + aTotal )
                                                             : 0;
                const long long all = s_allBytes > 0 ? s_allBytes.load() : fileTotal;
                const long long got = ( s_allBytes > 0 ? s_doneBytes.load() : 0 ) + have + aNow;

                wxString what = wxString::Format( _( "Downloading %s:" ), wxString( aArchive.folder ) );

                if( all > 0 )
                    what += wxString::Format( _( " %.0f of %.0f MB" ), got / mb, all / mb );
                else
                    what += wxString::Format( _( " %.0f MB" ), got / mb );

                if( aNow > 0 && firstData == 0 )
                    firstData = wxGetLocalTimeMillis();

                const double seconds = firstData == 0 ? 0.0
                                       : ( wxGetLocalTimeMillis() - firstData ).ToDouble() / 1000.0;

                // The speed needs a moment to mean something.
                if( all > got && seconds >= 2.0 && aNow > 0 )
                    what += wxS( ", " ) + timeLeft( ( all - got ) / ( aNow / seconds ) );

                int percent = aStep * 33;

                if( aSource.size > 0 )
                    percent += (int) std::min( 16.0, 16.0 * ( have + aNow ) / aSource.size );
                else if( aTotal > 0 )
                    percent += (int) ( 16.0 * ( have + aNow ) / ( have + aTotal ) );

                if( aProgress && !aProgress( what, percent ) )
                {
                    stopped = true;
                    return 1;
                }

                return 0;
            },
            250000L );

    const int result = curl.Perform();
    const int status = curl.GetResponseStatusCode();

    out.close();

    // Whatever arrived is kept for the next attempt: after the part when the server continued
    // it (206), in its place when the server started over (200).
    if( status == 206 )
    {
        appendFile( piece, part );
    }
    else if( status == 200 && fileSize( piece ) > 0 )
    {
        if( wxFileExists( part ) )
            wxRemoveFile( part );

        wxRenameFile( piece, part, true );
    }
    else if( status == 416 )
    {
        // The part is already as long as the file, or belongs to an older archive.
        if( wxFileExists( part ) )
            wxRemoveFile( part );
    }

    // (Removing a file that is not there is reported to the user as an error.)
    if( wxFileExists( piece ) )
        wxRemoveFile( piece );

    if( stopped )
        return stoppedMessage();

    if( stalled )
        return wxString::Format( _( "The connection to %s stopped answering while "
                                    "downloading the %s." ),
                                 aSource.host, wxString( aArchive.folder ) );

    if( result != 0 || ( status != 200 && status != 206 ) )
    {
        return wxString::Format( _( "The %s could not be downloaded from %s (%s)." ),
                                 wxString( aArchive.folder ), aSource.host,
                                 result != 0 ? wxString::FromUTF8( curl.GetErrorText( result ) )
                                             : wxString::Format( wxS( "HTTP %d" ), status ) );
    }

    return finish();
}


/**
 * Download one repository archive, trying again after a pause when the connection fails.
 *
 * @param aSources where to take it from, in order of preference; each try goes through them.
 * @param aFolder the download folder.
 * @param aFile set to the finished archive.
 */
wxString download( const ARCHIVE& aArchive, const std::vector<SOURCE>& aSources,
                   const wxString& aFolder, wxString* aFile,
                   const COLLAB_STDLIBS::PROGRESS& aProgress, int aStep )
{
    // An archive a run before this one finished is not fetched again.
    for( const SOURCE& source : aSources )
    {
        *aFile = aFolder + wxFileName::GetPathSeparator() + source.file;

        if( wxFileName::FileExists( *aFile ) )
            return wxEmptyString;
    }

    // A connection that fails is tried again for as long as it takes, with a pause that grows
    // to a minute: the network coming back is all it needs.  Only the user stops it.
    const int pauses[] = { 2, 5, 15, 30, 60 };
    wxString  error;

    for( int attempt = 0; ; attempt++ )
    {
        for( const SOURCE& source : aSources )
        {
            *aFile = aFolder + wxFileName::GetPathSeparator() + source.file;

            // A file that fails its checksum is fetched again from the same place at once,
            // before another source (which may hold another release) is asked.
            bool damaged = false;

            error = downloadOnce( aArchive, source, *aFile, aProgress, aStep, &damaged );

            if( damaged )
                error = downloadOnce( aArchive, source, *aFile, aProgress, aStep, &damaged );

            if( error.IsEmpty() || error == stoppedMessage() )
                return error;

            // A disk that cannot be written will not get better by waiting.
            if( error.StartsWith( _( "Cannot write" ) ) )
                return error;
        }

        const int pause = pauses[std::min( attempt, (int) std::size( pauses ) - 1 )];

        s_retryNow = false;
        s_waiting = true;

        for( int left = pause * 10; left > 0 && !s_retryNow; left-- )
        {
            if( aProgress
                && !aProgress( wxString::Format( _( "%s Trying again in %d s..." ), error,
                                                 ( left + 9 ) / 10 ),
                               -1 ) )
            {
                s_waiting = false;
                return stoppedMessage();
            }

            wxMilliSleep( 100 );
        }

        s_waiting = false;
    }
}


/// Unpack the libraries and the library table of one archive.
wxString unpack( const ARCHIVE& aArchive, const wxString& aZip, const wxString& aLibraryDir,
                 const wxString& aTemplateDir, const COLLAB_STDLIBS::PROGRESS& aProgress, int aStep )
{
    wxFFileInputStream file( aZip );

    if( !file.IsOk() )
        return wxString::Format( _( "Cannot read '%s'." ), aZip );

    const wxFileOffset size = file.GetLength();
    wxZipInputStream   zip( file );
    const wxString     suffix( aArchive.librarySuffix );
    const wxString     table( aArchive.table );
    int                libraries = 0;
    int                files = 0;
    bool               haveTable = false;
    wxString           lastLibrary;

    std::unique_ptr<wxZipEntry> entry;

    while( entry.reset( zip.GetNextEntry() ), entry )
    {
        if( entry->IsDir() )
            continue;

        // "kicad-symbols-master/Device.kicad_symdir/R.kicad_sym": the first part is the archive's
        // own folder.
        wxString name = entry->GetName( wxPATH_UNIX );
        name = name.AfterFirst( '/' );

        if( name.IsEmpty() || name.StartsWith( wxS( "/" ) ) || name.Contains( wxS( ".." ) )
            || name.Contains( wxS( ":" ) ) || name.Contains( wxS( "\\" ) ) )
        {
            continue;
        }

        wxString target;

        if( table.IsEmpty() )
        {
            // The templates repository: project templates and drawing sheets, which an
            // installed KiCad keeps side by side in its template folder.
            wxString rest;

            if( !name.StartsWith( wxS( "Projects/" ), &rest )
                && !name.StartsWith( wxS( "Worksheets/" ), &rest ) )
            {
                continue;
            }

            if( rest.IsEmpty() )
                continue;

            target = aTemplateDir + wxFileName::GetPathSeparator()
                     + wxFileName( rest, wxPATH_UNIX ).GetFullPath();
        }
        else if( name == table )
        {
            target = aTemplateDir + wxFileName::GetPathSeparator() + table;
            haveTable = true;
        }
        else
        {
            const wxString library = name.BeforeFirst( '/' );

            // A library is a folder of one file per part, or (older library sets) one file.
            const bool folderLibrary = name.Contains( wxS( "/" ) ) && library.EndsWith( suffix );
            const bool fileLibrary = !name.Contains( wxS( "/" ) )
                                     && ( name.EndsWith( wxS( ".kicad_sym" ) )
                                          || name.EndsWith( wxS( ".sp" ) ) )
                                     && suffix == wxS( ".kicad_symdir" );

            if( !folderLibrary && !fileLibrary )
                continue;

            if( library != lastLibrary )
            {
                lastLibrary = library;
                libraries++;

                int percent = aStep * 33 + 16;

                if( size > 0 )
                    percent += (int) ( 16.0 * file.TellI() / size );

                if( aProgress
                    && !aProgress( wxString::Format( _( "Unpacking %s (%d libraries)..." ),
                                                     wxString( aArchive.folder ), libraries ),
                                   percent ) )
                {
                    return stoppedMessage();
                }
            }

            target = aLibraryDir + wxFileName::GetPathSeparator()
                     + wxFileName( name, wxPATH_UNIX ).GetFullPath();
        }

        wxFileName fn( target );

        if( !fn.DirExists() && !wxFileName::Mkdir( fn.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
            return wxString::Format( _( "Cannot write to '%s'." ), fn.GetPath() );

        wxFFileOutputStream out( target );

        if( !out.IsOk() )
            return wxString::Format( _( "Cannot write '%s'." ), target );

        zip.Read( out );

        if( !out.IsOk() || !out.Close() )
            return wxString::Format( _( "Cannot write '%s'." ), target );

        files++;
    }

    if( files == 0 || ( !haveTable && !table.IsEmpty() ) )
    {
        return wxString::Format( _( "The downloaded %s archive is not a KiCad library set." ),
                                 wxString( aArchive.folder ) );
    }

    return wxEmptyString;
}

} // namespace


bool COLLAB_STDLIBS::Needed()
{
    wxFileName symbols;
    symbols.AssignDir( PATHS::GetStockSymbolsPath() );

    return !symbols.DirExists();
}


bool COLLAB_STDLIBS::IsDownloadableLibraryError( const wxString& aMessage )
{
    // A standard library that is not on this computer is not a fault to warn about while the
    // set can be downloaded (or is on its way): the download is the answer, and it brings the
    // library.  Anything else that fails to load is still reported.
    wxString message = aMessage;
    message.Replace( wxS( "\\" ), wxS( "/" ) );

    // An error that names the folder the libraries were looked for in before the download put
    // them elsewhere is left over from then (an editor that was open keeps it): the library
    // is here now, at its new place.
    {
        std::lock_guard<std::mutex> lock( s_formerMutex );

        for( const wxString& dir : s_formerDirs )
        {
            if( message.Contains( dir + wxS( "/" ) ) )
                return true;
        }
    }

    if( !Running() && !Needed() )
        return false;

    for( wxString dir : { PATHS::GetStockSymbolsPath(), PATHS::GetStockFootprintsPath(),
                          PATHS::GetStockDesignBlocksPath(), PATHS::GetStock3dmodelsPath(),
                          PATHS::GetManagedLibrariesPath() } )
    {
        dir.Replace( wxS( "\\" ), wxS( "/" ) );

        while( dir.EndsWith( wxS( "/" ) ) )
            dir.RemoveLast();

        if( !dir.IsEmpty() && message.Contains( dir + wxS( "/" ) ) )
            return true;
    }

    return false;
}


bool COLLAB_STDLIBS::Interrupted()
{
    // Also with libraries in place: a "download again" that was cut short continues too.
    return wxFileName::FileExists( downloadFolder() + wxFileName::GetPathSeparator()
                                      + wxS( "in-progress" ) );
}


bool COLLAB_STDLIBS::Waiting()
{
    return s_waiting;
}


void COLLAB_STDLIBS::RetryNow()
{
    s_retryNow = true;
}


void COLLAB_STDLIBS::Forget()
{
    removeDir( downloadFolder() );
}


bool COLLAB_STDLIBS::Declined()
{
    return wxFileName::FileExists( declinedMarker() );
}


void COLLAB_STDLIBS::SetDeclined( bool aDeclined )
{
    const wxString marker = declinedMarker();

    if( aDeclined )
    {
        wxFFile file( marker, wxS( "w" ) );

        if( file.IsOpened() )
            file.Write( wxS( "The offer to download the standard libraries was declined.\n" ) );
    }
    else if( wxFileName::FileExists( marker ) )
    {
        wxRemoveFile( marker );
    }
}


bool COLLAB_STDLIBS::Running()
{
    return s_running;
}


void COLLAB_STDLIBS::Suspend()
{
    s_suspended = true;
}


int COLLAB_STDLIBS::Percent()
{
    return s_percent;
}


wxString COLLAB_STDLIBS::StillDownloadingNotice()
{
    if( !Running() )
        return wxEmptyString;

    return wxString::Format( _( "The standard libraries are still downloading (%d%%). Their "
                                "parts cannot be chosen yet; they appear in the list by "
                                "themselves when the download has finished." ),
                             Percent() );
}


static bool install( const COLLAB_STDLIBS::PROGRESS& aProgress, wxString* aError );


bool COLLAB_STDLIBS::Install( const PROGRESS& aProgress, wxString* aError )
{
    // One at a time: a second caller is told the first is at work.
    if( s_running.exchange( true ) )
    {
        if( aError )
            *aError = _( "The standard libraries are already being downloaded." );

        return false;
    }

    s_percent = 0;
    s_suspended = false;

    bool ok = false;

    try
    {
        ok = install(
                [&]( const wxString& aMessage, int aPercent )
                {
                    if( aPercent >= 0 )
                        s_percent = std::clamp( aPercent, 0, 100 );

                    return !aProgress || aProgress( aMessage, aPercent );
                },
                aError );
    }
    catch( ... )
    {
        s_running = false;
        throw;
    }

    s_running = false;
    return ok;
}


static bool install( const COLLAB_STDLIBS::PROGRESS& aProgress, wxString* aError )
{
    auto fail =
            [&]( const wxString& aMessage )
            {
                if( aError )
                    *aError = aMessage;

                return false;
            };

    const wxString root = PATHS::GetManagedLibrariesPath();
    const wxString sep = wxFileName::GetPathSeparator();
    const wxString downloads = downloadFolder();
    const wxString incoming = root + sep + wxS( "incoming" );

    // The archives are kept in the download folder until everything is in place, so a run
    // that was cut short (the program closed, the computer slept, the network went away)
    // continues from what it has.  Unpacking is quick and always starts clean.
    if( !removeDir( incoming )
        || !wxFileName::Mkdir( incoming + sep + wxS( "template" ), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL )
        || ( !wxFileName::DirExists( downloads )
             && !wxFileName::Mkdir( downloads, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) ) )
    {
        return fail( wxString::Format( _( "Cannot write to '%s'." ), root ) );
    }

    {
        wxFFile marker( downloads + sep + wxS( "in-progress" ), wxS( "w" ) );

        if( marker.IsOpened() )
            marker.Write( libraryRef() + wxS( "\n" ) );
    }

    // The release the server holds is the one asked of the fallback too, so the three parts
    // always belong together.
    wxString                         serverRef;
    const std::map<wxString, SOURCE> fromServer = serverSources( &serverRef );

    wxString error;
    int      step = 0;

    // The size of everything, for the progress text, when the server told all of it.
    long long allBytes = 0;

    for( const ARCHIVE& archive : ARCHIVES )
    {
        auto it = fromServer.find( wxString( archive.folder ) );

        if( it == fromServer.end() || it->second.size <= 0 )
        {
            allBytes = 0;
            break;
        }

        allBytes += it->second.size;
    }

    s_allBytes = allBytes;
    s_doneBytes = 0;

    for( const ARCHIVE& archive : ARCHIVES )
    {
        // The collaboration server first (a download can continue in the middle of a file
        // there), the KiCad library repositories when it cannot deliver.
        std::vector<SOURCE> sources;

        if( auto it = fromServer.find( wxString( archive.folder ) ); it != fromServer.end() )
            sources.push_back( it->second );

        sources.push_back( gitlabSource( archive, serverRef ) );

        wxString zip;

        // An archive that does not unpack (damaged on the way, or cut off) is fetched once more.
        for( int round = 0; round < 2; round++ )
        {
            error = download( archive, sources, downloads, &zip, aProgress, step );

            if( !error.IsEmpty() )
                break;

            removeDir( incoming + sep + wxString( archive.folder ) );

            error = unpack( archive, zip, incoming + sep + wxString( archive.folder ),
                            incoming + sep + wxS( "template" ), aProgress, step );

            if( error.IsEmpty() || error == stoppedMessage() )
                break;

            wxRemoveFile( zip );
        }

        if( error.IsEmpty() )
            s_doneBytes += std::max<long long>( 0, fileSize( zip ) );

        if( !error.IsEmpty() )
        {
            removeDir( incoming );

            // Stopped by the user: nothing continues by itself at the next start.  The
            // archives stay, so asking again is quick.
            if( error == stoppedMessage() && !s_suspended )
                wxRemoveFile( downloads + sep + wxS( "in-progress" ) );

            return fail( error );
        }

        step++;
    }

    if( aProgress )
        aProgress( _( "Putting the libraries in place..." ), 100 );

    // The symbols folder is what marks the libraries as installed, so it goes in last.
    for( const wxString& part : { wxString( wxS( "template" ) ), wxString( wxS( "footprints" ) ),
                                  wxString( wxS( "symbols" ) ) } )
    {
        if( !removeDir( root + sep + part )
            || !wxRenameFile( incoming + sep + part, root + sep + part, false ) )
        {
            removeDir( incoming );
            return fail( wxString::Format( _( "Cannot write to '%s'." ), root + sep + part ) );
        }
    }

    removeDir( incoming );
    removeDir( downloads );
    return true;
}


void COLLAB_STDLIBS::Activate()
{
    // The library folders the path variables were given when the program started.
    const std::map<wxString, wxString> before = {
        { PATHS::GetStockSymbolsPath(), wxS( "symbols" ) },
        { PATHS::GetStockFootprintsPath(), wxS( "footprints" ) },
        { PATHS::GetStock3dmodelsPath(), wxS( "3dmodels" ) },
        { PATHS::GetStockDesignBlocksPath(), wxS( "blocks" ) },
        { PATHS::GetStockTemplatesPath(), wxS( "template" ) },
    };

    PATHS::ForgetStockLibraryProbe();

    // Remember where the libraries were looked for until now (see IsDownloadableLibraryError).
    {
        std::lock_guard<std::mutex> lock( s_formerMutex );

        for( const auto& [dir, kind] : before )
        {
            wxString former = dir;
            former.Replace( wxS( "\\" ), wxS( "/" ) );

            while( former.EndsWith( wxS( "/" ) ) )
                former.RemoveLast();

            wxString now = kind == wxS( "symbols" )      ? PATHS::GetStockSymbolsPath()
                           : kind == wxS( "footprints" ) ? PATHS::GetStockFootprintsPath()
                           : kind == wxS( "3dmodels" )   ? PATHS::GetStock3dmodelsPath()
                           : kind == wxS( "blocks" )     ? PATHS::GetStockDesignBlocksPath()
                                                         : PATHS::GetStockTemplatesPath();
            now.Replace( wxS( "\\" ), wxS( "/" ) );

            while( now.EndsWith( wxS( "/" ) ) )
                now.RemoveLast();

            if( !former.IsEmpty() && former != now )
                s_formerDirs.push_back( former );
        }
    }

    const std::map<wxString, wxString> after = {
        { wxS( "symbols" ), PATHS::GetStockSymbolsPath() },
        { wxS( "footprints" ), PATHS::GetStockFootprintsPath() },
        { wxS( "3dmodels" ), PATHS::GetStock3dmodelsPath() },
        { wxS( "blocks" ), PATHS::GetStockDesignBlocksPath() },
        { wxS( "template" ), PATHS::GetStockTemplatesPath() },
    };

    // A variable the user (or the environment) pointed somewhere else keeps its value; one
    // still at the old built-in folder follows the libraries to where they are now.
    if( COMMON_SETTINGS* common = Pgm().GetCommonSettings() )
    {
        for( auto& [key, item] : common->m_Env.vars )
        {
            auto kind = before.find( item.GetValue() );

            if( kind == before.end() || item.GetValue() != item.GetDefault() )
                continue;

            const wxString& value = after.at( kind->second );
            item = ENV_VAR_ITEM( key, value, value );
        }

        Pgm().SetLocalEnvVariables();
    }

    // A global table written while there were no libraries is an empty list: give it the
    // standard set now.  A table that already lists libraries of the user's own keeps them and
    // gets the standard set added when it is not in it yet.
    LIBRARY_MANAGER& manager = Pgm().GetLibraryManager();

    for( LIBRARY_TABLE_TYPE type : { LIBRARY_TABLE_TYPE::SYMBOL, LIBRARY_TABLE_TYPE::FOOTPRINT } )
    {
        if( !wxFileName( LIBRARY_MANAGER::StockTablePath( type ) ).IsFileReadable() )
            continue;

        std::optional<LIBRARY_TABLE*> table = manager.Table( type, LIBRARY_TABLE_SCOPE::GLOBAL );

        if( !table || !*table || ( *table )->Rows().empty() )
        {
            LIBRARY_MANAGER::CreateGlobalTable( type, true );
            continue;
        }

        bool listed = false;

        for( const LIBRARY_TABLE_ROW& row : ( *table )->Rows() )
        {
            if( row.Type() == LIBRARY_TABLE_ROW::TABLE_TYPE_NAME )
                listed = true;
        }

        if( listed )
            continue;

        LIBRARY_TABLE_ROW& chained = ( *table )->InsertRow();
        chained.SetType( LIBRARY_TABLE_ROW::TABLE_TYPE_NAME );
        chained.SetNickname( wxT( "KiCad" ) );
        chained.SetDescription( _( "KiCad Default Libraries" ) );
        chained.SetURI( LIBRARY_MANAGER::StockTableReferenceURI( type ) );
        ( *table )->Save();
    }

    manager.LoadGlobalTables();
}
