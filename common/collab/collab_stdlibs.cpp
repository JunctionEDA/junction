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

#include <wx/dir.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/intl.h>
#include <wx/utils.h>
#include <wx/wfstream.h>
#include <wx/zipstrm.h>

#include <kicad_curl/kicad_curl_easy.h>
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

// The project templates and drawing sheets come first and the symbols last: the symbols folder
// is what marks the set as installed.
const ARCHIVE ARCHIVES[] = {
    { "kicad-templates", "templates", "", "" },
    { "kicad-footprints", "footprints", ".pretty", "fp-lib-table" },
    { "kicad-symbols", "symbols", ".kicad_symdir", "sym-lib-table" },
};


wxString libraryRef()
{
    wxString ref;

    if( wxGetEnv( wxS( "JUNCTION_LIBRARIES_REF" ), &ref ) && !ref.IsEmpty() )
        return ref;

    return wxS( "master" );
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


/**
 * One attempt at one repository archive.  What an earlier attempt (or an earlier run of the
 * program) already fetched stays in "<target>.part"; the server is asked for the rest, and
 * when it sends the whole file anyway the part is replaced.
 *
 * @return an empty string once "<target>" is complete, or what went wrong.
 */
wxString downloadOnce( const ARCHIVE& aArchive, const wxString& aTarget,
                       const COLLAB_STDLIBS::PROGRESS& aProgress, int aStep )
{
    const wxString ref = libraryRef();
    const wxString url = wxString::Format(
            wxS( "https://gitlab.com/kicad/libraries/%s/-/archive/%s/%s-%s.zip" ),
            aArchive.repository, ref, aArchive.repository, ref );

    const wxString     part = aTarget + wxS( ".part" );
    const wxString     piece = aTarget + wxS( ".piece" );
    const wxFileOffset have = fileSize( part );

    std::ofstream out( piece.fn_str(), std::ios::binary | std::ios::trunc );

    if( !out.is_open() )
        return wxString::Format( _( "Cannot write '%s'." ), piece );

    bool       stopped = false;
    bool       stalled = false;
    size_t     lastNow = 0;
    wxLongLong lastMoved = wxGetLocalTimeMillis();

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

                const wxString what = wxString::Format( _( "Downloading the %s (%.0f MB)..." ),
                                                        wxString( aArchive.folder ),
                                                        ( have + aNow ) / 1048576.0 );
                int percent = aStep * 33;

                if( aTotal > 0 )
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
        wxRemoveFile( part );
        wxRenameFile( piece, part, true );
    }
    else if( status == 416 )
    {
        // The part is already as long as the file, or belongs to an older archive.
        wxRemoveFile( part );
    }

    wxRemoveFile( piece );

    if( stopped )
        return stoppedMessage();

    if( stalled )
        return wxString::Format( _( "The connection to gitlab.com stopped answering while "
                                    "downloading the %s." ),
                                 wxString( aArchive.folder ) );

    if( result != 0 || ( status != 200 && status != 206 ) )
    {
        return wxString::Format( _( "The %s could not be downloaded from gitlab.com (%s)." ),
                                 wxString( aArchive.folder ),
                                 result != 0 ? wxString::FromUTF8( curl.GetErrorText( result ) )
                                             : wxString::Format( wxS( "HTTP %d" ), status ) );
    }

    if( !wxRenameFile( part, aTarget, true ) )
        return wxString::Format( _( "Cannot write '%s'." ), aTarget );

    return wxEmptyString;
}


/// Download one repository archive, trying again after a pause when the connection fails.
wxString download( const ARCHIVE& aArchive, const wxString& aTarget,
                   const COLLAB_STDLIBS::PROGRESS& aProgress, int aStep )
{
    // An archive a run before this one finished is not fetched again.
    if( wxFileName::FileExists( aTarget ) )
        return wxEmptyString;

    // A connection that fails is tried again for as long as it takes, with a pause that grows
    // to a minute: the network coming back is all it needs.  Only the user stops it.
    const int pauses[] = { 2, 5, 15, 30, 60 };
    wxString  error;

    for( int attempt = 0; ; attempt++ )
    {
        error = downloadOnce( aArchive, aTarget, aProgress, aStep );

        if( error.IsEmpty() || error == stoppedMessage() )
            return error;

        // A disk that cannot be written will not get better by waiting.
        if( error.StartsWith( _( "Cannot write" ) ) )
            return error;

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
                    && !aProgress( wxString::Format( _( "Unpacking the %s (%d libraries)..." ),
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


bool COLLAB_STDLIBS::Interrupted()
{
    return Needed()
           && wxFileName::FileExists( downloadFolder() + wxFileName::GetPathSeparator()
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


bool COLLAB_STDLIBS::Install( const PROGRESS& aProgress, wxString* aError )
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

    wxString error;
    int      step = 0;

    for( const ARCHIVE& archive : ARCHIVES )
    {
        const wxString zip = downloads + sep
                             + wxString::Format( wxS( "%s-%s.zip" ), archive.repository,
                                                 libraryRef() );

        // An archive that does not unpack (damaged on the way, or cut off) is fetched once more.
        for( int round = 0; round < 2; round++ )
        {
            error = download( archive, zip, aProgress, step );

            if( !error.IsEmpty() )
                break;

            removeDir( incoming + sep + wxString( archive.folder ) );

            error = unpack( archive, zip, incoming + sep + wxString( archive.folder ),
                            incoming + sep + wxS( "template" ), aProgress, step );

            if( error.IsEmpty() || error == stoppedMessage() )
                break;

            wxRemoveFile( zip );
        }

        if( !error.IsEmpty() )
        {
            removeDir( incoming );

            // Stopped by the user: nothing continues by itself at the next start.  The
            // archives stay, so asking again is quick.
            if( error == stoppedMessage() )
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

    // A global table written while there were no libraries is an empty list.  Give it the
    // standard set now; a table that already lists anything is the user's and stays.
    LIBRARY_MANAGER& manager = Pgm().GetLibraryManager();

    for( LIBRARY_TABLE_TYPE type : { LIBRARY_TABLE_TYPE::SYMBOL, LIBRARY_TABLE_TYPE::FOOTPRINT } )
    {
        if( !wxFileName( LIBRARY_MANAGER::StockTablePath( type ) ).IsFileReadable() )
            continue;

        std::optional<LIBRARY_TABLE*> table = manager.Table( type, LIBRARY_TABLE_SCOPE::GLOBAL );

        if( !table || !*table || ( *table )->Rows().empty() )
            LIBRARY_MANAGER::CreateGlobalTable( type, true );
    }

    manager.LoadGlobalTables();
}
