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

#include <collab/collab_project.h>
#include <paths.h>

#include <collab/collab_rest.h>
#include <io/kicad/kicad_io_utils.h>

#include <wx/log.h>

#include <wx/arrstr.h>
#include <wx/dir.h>
#include <wx/filename.h>
#include <wx/mstream.h>
#include <wx/translation.h>
#include <wx/wfstream.h>
#include <wx/msgdlg.h>
#include <wx/zipstrm.h>
#include <wx/app.h>
#include <wx/weakref.h>
#include <wx/window.h>

#include <map>
#include <thread>


static const wxChar* const traceCollab = wxT( "COLLAB" );


std::string COLLAB_PROJECT::ZipProjectFiles( const wxString& aProjectPath )
{
    // Recurse: hierarchical projects keep sub-sheets in subdirectories.  The
    // extension whitelist keeps backups, journals and outputs out of the upload.
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES | wxDIR_DIRS );

    wxMemoryOutputStream memStream;
    int                  entries = 0;

    {
        wxZipOutputStream zipStream( memStream );

        for( size_t i = 0; i < files.GetCount(); ++i )
        {
            wxFileName fn( files[ i ] );
            wxString   ext = fn.GetExt().Lower();
            wxString   name = fn.GetFullName();

            // Design files, project-local libraries (.kicad_sym, .pretty footprints),
            // 3D models, SPICE / IBIS model files and library tables all travel with the
            // project; the type is detected from the extension here and again on the server.
            bool wanted = ext == wxS( "kicad_pro" ) || ext == wxS( "kicad_sch" )
                          || ext == wxS( "kicad_pcb" ) || ext == wxS( "kicad_sym" )
                          || ext == wxS( "kicad_mod" ) || ext == wxS( "kicad_dru" )
                          || ext == wxS( "kicad_wks" ) || ext == wxS( "step" )
                          || ext == wxS( "stp" ) || ext == wxS( "wrl" ) || ext == wxS( "wrz" )
                          || ext == wxS( "lib" ) || ext == wxS( "sub" ) || ext == wxS( "cir" )
                          || ext == wxS( "mod" ) || ext == wxS( "spice" ) || ext == wxS( "ibs" )
                          || name == wxS( "sym-lib-table" ) || name == wxS( "fp-lib-table" )
                          || name == wxS( "design-block-lib-table" );

            if( !wanted )
                continue;

            // Store the project-relative path (forward slashes) so sub-sheets
            // land where the peer's document map expects them.
            wxFileName rel( files[ i ] );
            rel.MakeRelativeTo( aProjectPath );
            wxString entryName = rel.GetFullPath( wxPATH_UNIX );

            // The extension whitelist alone let the sync folder through: its base copies of
            // the board and schematic went up as documents of their own (and backups and
            // local history hold design files too).  Nothing under those directories is
            // project content.
            bool localState = false;

            for( const wxString& dir : rel.GetDirs() )
            {
                if( dir.EndsWith( wxS( ".collab" ) ) || dir.EndsWith( wxS( "-backups" ) )
                    || dir.StartsWith( wxS( "." ) ) )
                {
                    localState = true;
                    break;
                }
            }

            if( localState )
                continue;

            wxFFileInputStream input( files[ i ] );

            if( !input.IsOk() )
                continue;

            zipStream.PutNextEntry( entryName );
            zipStream.Write( input );
            entries++;
        }

        if( !zipStream.Close() || entries == 0 )
            return std::string();
    }

    size_t size = memStream.GetSize();

    if( size == 0 )
        return std::string();

    std::string bytes;
    bytes.resize( size );
    memStream.CopyTo( bytes.data(), size );

    return bytes;
}


std::optional<nlohmann::json> COLLAB_PROJECT::CreateAndShare( const wxString& aServer,
                                                              const wxString& aToken,
                                                              const wxString& aProjectPath,
                                                              const wxString& aProjectName,
                                                              wxString& aShareUrl,
                                                              wxString& aError )
{
    std::string zipBytes = ZipProjectFiles( aProjectPath );

    if( zipBytes.empty() )
    {
        aError = _( "No project files found to share.  Save the project first." );
        return std::nullopt;
    }

    // The server's upload limit (server/src/http.rs MAX_TOTAL_BYTES).  More than this is cut off
    // while it is being sent, which reads as a lost connection, so it is said here instead.
    const size_t maxUpload = 500u * 1024 * 1024;

    if( zipBytes.size() > maxUpload )
    {
        aError = wxString::Format( _( "The project's files come to %.0f MB zipped, and an online project can hold "
                                      "500 MB.\n\nLeave out 3D models that are not needed, or split the project." ),
                                   zipBytes.size() / 1048576.0 );
        return std::nullopt;
    }

    COLLAB_REST::ERROR_INFO uploadError;

    std::optional<nlohmann::json> project =
            COLLAB_REST::CreateProject( aServer, aToken, aProjectName, zipBytes, &uploadError );

    if( !project )
    {
        aError = _( "Uploading the project to the collaboration server failed." );

        // The server's own reason (a file over the size limit, too many files, no room left)
        // is what the user can act on.
        if( !uploadError.message.IsEmpty() )
            aError += wxS( "\n\n" ) + uploadError.message;

        return std::nullopt;
    }

    wxString projectId = wxString::FromUTF8( project->value( "projectId", "" ) );

    std::optional<nlohmann::json> link =
            COLLAB_REST::CreateShareLink( aServer, aToken, projectId, wxS( "editor" ) );

    if( !link )
    {
        aError = _( "Creating the share link failed." );
        return std::nullopt;
    }

    aShareUrl = wxString::FromUTF8( link->value( "url", "" ) );

    // What was just uploaded is the online project: base the merge on it.
    SeedSyncBases( aProjectPath, aProjectName );

    return project;
}


void COLLAB_PROJECT::CreateAndShareAsync(
        wxWindow* aOwner, const wxString& aServer, const wxString& aToken,
        const wxString& aProjectPath, const wxString& aProjectName,
        std::function<void( std::optional<nlohmann::json>, const wxString&, const wxString& )> aDone )
{
    // Strings cross the thread boundary as UTF-8 so no wxString buffer is shared.
    std::string server = aServer.ToStdString( wxConvUTF8 );
    std::string token = aToken.ToStdString( wxConvUTF8 );
    std::string path = aProjectPath.ToStdString( wxConvUTF8 );
    std::string name = aProjectName.ToStdString( wxConvUTF8 );

    wxWeakRef<wxWindow> owner( aOwner );

    std::thread(
            [server, token, path, name, owner, aDone]()
            {
                wxString url;
                wxString error;

                std::optional<nlohmann::json> project;

                try
                {
                    project = CreateAndShare( wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                                              wxString::FromUTF8( path ), wxString::FromUTF8( name ),
                                              url, error );
                }
                catch( ... )
                {
                    error = _( "Publishing the project failed." );
                }

                std::string urlStd = url.ToStdString( wxConvUTF8 );
                std::string errorStd = error.ToStdString( wxConvUTF8 );

                if( !wxTheApp )
                    return;

                wxTheApp->CallAfter(
                        [owner, aDone, project, urlStd, errorStd]()
                        {
                            // The window that asked is gone: nobody to tell.
                            if( !owner )
                                return;

                            aDone( project, wxString::FromUTF8( urlStd ),
                                   wxString::FromUTF8( errorStd ) );
                        } );
            } )
            .detach();
}


std::optional<nlohmann::json> COLLAB_PROJECT::ClaimAndFetch( const wxString& aServer,
                                                             const wxString& aToken,
                                                             const wxString& aLinkToken,
                                                             wxString& aError )
{
    std::optional<nlohmann::json> claim = COLLAB_REST::ClaimLink( aServer, aToken, aLinkToken );

    if( !claim )
    {
        aError = _( "The share link is invalid or has expired." );
        return std::nullopt;
    }

    wxString projectId = wxString::FromUTF8( claim->value( "projectId", "" ) );

    std::optional<nlohmann::json> project = COLLAB_REST::GetProject( aServer, aToken, projectId );

    if( !project )
    {
        aError = _( "Unable to fetch the shared project." );
        return std::nullopt;
    }

    return project;
}


wxString COLLAB_PROJECT::ParseLinkToken( const wxString& aInput )
{
    wxString input = aInput;
    input.Trim( true ).Trim( false );

    // The web landing page's "Open in KiCad" button uses this scheme.
    if( input.StartsWith( wxS( "kicad-collab://join/" ) ) )
        input = input.Mid( wxString( wxS( "kicad-collab://join/" ) ).length() );

    int pos = input.Find( wxS( "/j/" ) );

    if( pos != wxNOT_FOUND )
        input = input.Mid( pos + 3 );

    // Strip any trailing URL components.
    input = input.BeforeFirst( '/' ).BeforeFirst( '?' ).BeforeFirst( '#' );

    return input;
}


static wxString collabDirPath( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxFileName dir( aProjectPath, wxEmptyString );
    dir.AppendDir( aProjectName + wxS( ".collab" ) );

    return dir.GetPath();
}


static wxString localLinkPath( const wxString& aProjectPath, const wxString& aProjectName )
{
    return wxFileName( collabDirPath( aProjectPath, aProjectName ), wxS( "link.json" ) )
            .GetFullPath();
}


/// <project>.collab/base/<aRelPath>, or empty for a path that climbs out of it.
static wxString syncBasePath( const wxString& aProjectPath, const wxString& aProjectName,
                              const wxString& aRelPath )
{
    if( aRelPath.IsEmpty() )
        return wxEmptyString;

    wxFileName rel( aRelPath, wxPATH_UNIX );
    wxFileName file( collabDirPath( aProjectPath, aProjectName ), wxEmptyString );
    file.AppendDir( wxS( "base" ) );

    for( const wxString& dir : rel.GetDirs() )
    {
        if( dir == wxS( ".." ) )
            return wxEmptyString;

        file.AppendDir( dir );
    }

    file.SetFullName( rel.GetFullName() );

    return file.GetFullPath();
}


wxString COLLAB_PROJECT::SyncBasePath( const wxString& aProjectPath, const wxString& aProjectName,
                                       const wxString& aRelPath )
{
    return syncBasePath( aProjectPath, aProjectName, aRelPath );
}


static std::string readWholeFile( const wxString& aPath )
{
    if( aPath.IsEmpty() || !wxFileName::FileExists( aPath ) )
        return std::string();

    wxFFileInputStream in( aPath );

    if( !in.IsOk() )
        return std::string();

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    return text;
}


void COLLAB_PROJECT::WriteSyncBase( const wxString& aProjectPath, const wxString& aProjectName,
                                    const wxString& aRelPath, const std::string& aText )
{
    wxFileName file( syncBasePath( aProjectPath, aProjectName, aRelPath ) );

    if( file.GetFullPath().IsEmpty() )
        return;

    if( !file.DirExists()
        && !wxFileName::Mkdir( file.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        return;
    }

    wxFFileOutputStream out( file.GetFullPath() );

    if( out.IsOk() )
        out.Write( aText.data(), aText.size() );
}


std::string COLLAB_PROJECT::ReadSyncBase( const wxString& aProjectPath,
                                          const wxString& aProjectName,
                                          const wxString& aRelPath )
{
    return readWholeFile( syncBasePath( aProjectPath, aProjectName, aRelPath ) );
}


void COLLAB_PROJECT::RefreshSyncBaseFromDisk( const wxString& aProjectPath,
                                              const wxString& aProjectName,
                                              const wxString& aRelPath )
{
    wxFileName doc( aProjectPath + wxFileName::GetPathSeparator()
                    + wxFileName( aRelPath, wxPATH_UNIX ).GetFullPath() );

    std::string text = readWholeFile( doc.GetFullPath() );

    if( !text.empty() )
        WriteSyncBase( aProjectPath, aProjectName, aRelPath, text );
}


void COLLAB_PROJECT::SeedSyncBases( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES | wxDIR_DIRS );

    for( const wxString& path : files )
    {
        wxFileName fn( path );
        wxString   ext = fn.GetExt().Lower();

        if( ext != wxS( "kicad_pcb" ) && ext != wxS( "kicad_sch" ) )
            continue;

        wxFileName rel( path );
        rel.MakeRelativeTo( aProjectPath );

        // Not the copies inside .collab/base itself, backups, or local history.
        bool skip = false;

        for( const wxString& dir : rel.GetDirs() )
        {
            if( dir.EndsWith( wxS( ".collab" ) ) || dir.EndsWith( wxS( "-backups" ) )
                || dir.StartsWith( wxS( "." ) ) )
            {
                skip = true;
                break;
            }
        }

        if( !skip )
            RefreshSyncBaseFromDisk( aProjectPath, aProjectName, rel.GetFullPath( wxPATH_UNIX ) );
    }
}


void COLLAB_PROJECT::UnlinkLocalProject( const wxString& aProjectPath,
                                         const wxString& aProjectName )
{
    wxString server;
    wxString projectId = ReadLocalLink( aProjectPath, aProjectName, server );

    if( !projectId.IsEmpty() )
        ForgetLocalCopy( projectId );

    wxString dir = collabDirPath( aProjectPath, aProjectName );

    if( wxFileName::DirExists( dir ) )
        wxFileName::Rmdir( dir, wxPATH_RMDIR_RECURSIVE );
}


void COLLAB_PROJECT::WriteLocalLink( const wxString& aProjectPath, const wxString& aProjectName,
                                     const wxString& aServer, const wxString& aProjectId )
{
    wxFileName file( localLinkPath( aProjectPath, aProjectName ) );

    if( !file.DirExists() && !wxFileName::Mkdir( file.GetPath(), wxS_DIR_DEFAULT,
                                                 wxPATH_MKDIR_FULL ) )
        return;

    nlohmann::json link = {
        { "server", aServer.ToStdString( wxConvUTF8 ) },
        { "projectId", aProjectId.ToStdString( wxConvUTF8 ) },
    };

    wxFFileOutputStream out( file.GetFullPath() );

    if( out.IsOk() )
    {
        std::string text = link.dump( 2 );
        out.Write( text.data(), text.size() );
    }
}


wxString COLLAB_PROJECT::ReadLocalLink( const wxString& aProjectPath,
                                        const wxString& aProjectName, wxString& aServer )
{
    wxFileName file( localLinkPath( aProjectPath, aProjectName ) );

    if( !file.FileExists() )
        return wxEmptyString;

    wxFFileInputStream in( file.GetFullPath() );

    if( !in.IsOk() )
        return wxEmptyString;

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    try
    {
        nlohmann::json link = nlohmann::json::parse( text );

        aServer = wxString::FromUTF8( link.value( "server", "" ) );
        return wxString::FromUTF8( link.value( "projectId", "" ) );
    }
    catch( ... )
    {
        return wxEmptyString;
    }
}


static wxString localCopiesPathIn( const wxString& aRegistryDir )
{
    return wxFileName( aRegistryDir, wxS( "collab-local-copies.json" ) ).GetFullPath();
}


void COLLAB_PROJECT::RecordLocalCopy( const wxString& aProjectId, const wxString& aProFile )
{
    RecordLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId, aProFile );
}


wxString COLLAB_PROJECT::FindLocalCopy( const wxString& aProjectId )
{
    return FindLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId );
}


void COLLAB_PROJECT::ForgetLocalCopy( const wxString& aProjectId )
{
    ForgetLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId );
}


bool COLLAB_PROJECT::IsLinked( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxString server;
    return !ReadLocalLink( aProjectPath, aProjectName, server ).IsEmpty();
}


void COLLAB_PROJECT::WriteCachedProject( const wxString& aProjectPath,
                                         const wxString& aProjectName,
                                         const nlohmann::json& aProject )
{
    wxFileName file( collabDirPath( aProjectPath, aProjectName ), wxS( "project.json" ) );

    if( !file.DirExists() )
        return;     // not a linked copy

    // Only what a session needs to start; the rest (members, sharing) is the server's
    // business and has no place in a file that travels with the project folder.
    nlohmann::json kept = {
        { "projectId", aProject.value( "projectId", "" ) },
        { "ownerId", aProject.value( "ownerId", 0LL ) },
        { "docs", nlohmann::json::array() },
    };

    if( aProject.contains( "docs" ) && aProject[ "docs" ].is_array() )
    {
        for( const nlohmann::json& doc : aProject[ "docs" ] )
        {
            if( !doc.is_object() )
                continue;

            kept[ "docs" ].push_back( {
                { "docId", doc.value( "docId", "" ) },
                { "path", doc.value( "path", "" ) },
                { "docType", doc.value( "docType", "" ) },
            } );
        }
    }

    std::string text = kept.dump( 2 );

    if( readWholeFile( file.GetFullPath() ) == text )
        return;

    wxFFileOutputStream out( file.GetFullPath() );

    if( out.IsOk() )
        out.Write( text.data(), text.size() );
}


std::optional<nlohmann::json> COLLAB_PROJECT::ReadCachedProject( const wxString& aProjectPath,
                                                                 const wxString& aProjectName,
                                                                 const wxString& aProjectId )
{
    wxFileName file( collabDirPath( aProjectPath, aProjectName ), wxS( "project.json" ) );

    std::string text = readWholeFile( file.GetFullPath() );

    if( text.empty() )
        return std::nullopt;

    try
    {
        nlohmann::json project = nlohmann::json::parse( text );

        if( project.is_object()
            && wxString::FromUTF8( project.value( "projectId", "" ) ) == aProjectId
            && project.contains( "docs" ) && project[ "docs" ].is_array() )
        {
            return project;
        }
    }
    catch( ... )
    {
    }

    return std::nullopt;
}


bool COLLAB_PROJECT::ConfirmRelink( wxWindow* aParent, const wxString& aProjectPath,
                                    const wxString& aProjectName, const wxString& aNewProjectId )
{
    wxString server;
    wxString current = ReadLocalLink( aProjectPath, aProjectName, server );

    if( current.IsEmpty() || current == aNewProjectId )
        return true;

    int answer = wxMessageBox(
            _( "This project folder is already synced with a different online project.\n\n"
               "A folder can follow only one online project.  Link it to the new one instead?  "
               "The previous link is dropped (the online project itself is not changed), and "
               "edits made here since the last sync are merged into the new project." ),
            _( "Join Online Project" ), wxYES_NO | wxNO_DEFAULT | wxICON_WARNING, aParent );

    if( answer != wxYES )
        return false;

    // The registry maps a project id to its local copy; the old id must not keep claiming
    // this folder or "Open" from the online list lands two projects in it.
    ForgetLocalCopy( current );
    return true;
}


void COLLAB_PROJECT::ForgetLocalCopyIn( const wxString& aRegistryDir, const wxString& aProjectId )
{
    std::string text = readWholeFile( localCopiesPathIn( aRegistryDir ) );

    if( text.empty() )
        return;

    nlohmann::json map;

    try
    {
        map = nlohmann::json::parse( text );
    }
    catch( ... )
    {
        return;
    }

    if( !map.is_object() || !map.contains( aProjectId.ToStdString( wxConvUTF8 ) ) )
        return;

    map.erase( aProjectId.ToStdString( wxConvUTF8 ) );

    wxFFileOutputStream out( localCopiesPathIn( aRegistryDir ) );

    if( out.IsOk() )
    {
        std::string dump = map.dump( 2 );
        out.Write( dump.data(), dump.size() );
    }
}


void COLLAB_PROJECT::RecordLocalCopyIn( const wxString& aRegistryDir, const wxString& aProjectId,
                                        const wxString& aProFile )
{
    nlohmann::json map = nlohmann::json::object();

    if( wxFileName::FileExists( localCopiesPathIn( aRegistryDir ) ) )
    {
        wxFFileInputStream in( localCopiesPathIn( aRegistryDir ) );

        if( in.IsOk() )
        {
            std::string text;
            text.resize( in.GetLength() );
            in.Read( text.data(), text.size() );

            try
            {
                map = nlohmann::json::parse( text );
            }
            catch( ... )
            {
                map = nlohmann::json::object();
            }
        }
    }

    if( !map.is_object() )
        map = nlohmann::json::object();

    // One folder, one project: whatever other id claimed this .kicad_pro loses it (a folder
    // re-published or re-joined used to be listed under both ids).
    const std::string proFile = aProFile.ToStdString( wxConvUTF8 );

    for( auto it = map.begin(); it != map.end(); )
    {
        if( it.key() != aProjectId.ToStdString( wxConvUTF8 ) && it.value().is_string()
            && it.value().get<std::string>() == proFile )
        {
            it = map.erase( it );
        }
        else
        {
            ++it;
        }
    }

    map[ aProjectId.ToStdString( wxConvUTF8 ) ] = proFile;

    wxFFileOutputStream out( localCopiesPathIn( aRegistryDir ) );

    if( out.IsOk() )
    {
        std::string text = map.dump( 2 );
        out.Write( text.data(), text.size() );
    }
}


wxString COLLAB_PROJECT::FindLocalCopyIn( const wxString& aRegistryDir,
                                          const wxString& aProjectId )
{
    if( !wxFileName::FileExists( localCopiesPathIn( aRegistryDir ) ) )
        return wxEmptyString;

    wxFFileInputStream in( localCopiesPathIn( aRegistryDir ) );

    if( !in.IsOk() )
        return wxEmptyString;

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    wxString proFile;

    try
    {
        nlohmann::json map = nlohmann::json::parse( text );

        if( !map.is_object() )
            return wxEmptyString;

        proFile = wxString::FromUTF8(
                map.value( aProjectId.ToStdString( wxConvUTF8 ), std::string() ) );
    }
    catch( ... )
    {
        return wxEmptyString;
    }

    if( proFile.IsEmpty() || !wxFileName::FileExists( proFile ) )
        return wxEmptyString;

    // The directory must still be linked to this project: a moved or
    // repurposed copy must not be silently reused.
    wxFileName pro( proFile );
    wxString   server;
    wxString   linkedId = ReadLocalLink( pro.GetPath(), pro.GetName(), server );

    if( linkedId != aProjectId )
        return wxEmptyString;

    return proFile;
}


std::map<wxString, wxString> COLLAB_PROJECT::EnsureLibraryFolders( const wxString& aProjectPath )
{
    std::map<wxString, wxString> empty;
    wxFileName                   table( aProjectPath, wxS( "fp-lib-table" ) );

    if( !table.FileExists() )
        return empty;

    wxLogNull         noLog;
    wxFFileInputStream in( table.GetFullPath() );

    if( !in.IsOk() || in.GetLength() <= 0 || in.GetLength() > 4 * 1024 * 1024 )
        return empty;

    std::string bytes( static_cast<size_t>( in.GetLength() ), '\0' );
    in.Read( bytes.data(), bytes.size() );

    wxString text = wxString::FromUTF8( bytes.data(), in.LastRead() );

    // One row per "(lib ": (name X)(type KiCad)(uri "${KIPRJMOD}/x.pretty"), with or without
    // quotes; older tables write the variable as $(KIPRJMOD).
    auto field = []( const wxString& aRow, const wxString& aKey ) -> wxString
    {
        size_t at = aRow.find( wxS( "(" ) + aKey );

        if( at == wxString::npos )
            return wxEmptyString;

        at += aKey.length() + 1;

        while( at < aRow.length() && wxIsspace( aRow[at] ) )
            at++;

        if( at < aRow.length() && aRow[at] == '"' )
        {
            wxString value;

            for( at++; at < aRow.length() && aRow[at] != '"'; at++ )
            {
                if( aRow[at] == '\\' && at + 1 < aRow.length() )
                    at++;

                value += aRow[at];
            }

            return value;
        }

        const size_t end = aRow.find( wxS( ')' ), at );
        return end == wxString::npos ? wxString() : aRow.Mid( at, end - at ).Trim();
    };

    // A table written on one line still splits at each row's opening.
    text.Replace( wxS( "(lib " ), wxS( "\n(lib " ) );

    const wxArrayString rows = wxSplit( text, '\n', '\0' );

    for( wxString row : rows )
    {
        if( !row.Trim( false ).StartsWith( wxS( "(lib " ) ) )
            continue;

        const wxString name = field( row, wxS( "name" ) );
        wxString       rel = field( row, wxS( "uri" ) );

        if( rel.StartsWith( wxS( "${KIPRJMOD}/" ) ) || rel.StartsWith( wxS( "$(KIPRJMOD)/" ) ) )
            rel = rel.Mid( 12 );
        else
            continue;

        // Only plain folders below the project: no escapes, variables or parent steps.
        if( rel.IsEmpty() || !rel.Lower().EndsWith( wxS( ".pretty" ) ) || rel.Contains( wxS( ".." ) )
            || rel.Contains( wxS( "$" ) ) || rel.Contains( wxS( "\\" ) ) || rel.Contains( wxS( ":" ) )
            || rel.StartsWith( wxS( "/" ) ) )
        {
            continue;
        }

        wxFileName dir = wxFileName::DirName( aProjectPath );

        for( const wxString& part : wxSplit( rel, '/', '\0' ) )
        {
            if( !part.IsEmpty() )
                dir.AppendDir( part );
        }

        if( wxFileName::FileExists( dir.GetPath() ) )
            continue;

        if( !dir.DirExists() )
            wxFileName::Mkdir( dir.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );

        if( !name.IsEmpty() && dir.DirExists()
            && wxDir::FindFirst( dir.GetPath(), wxS( "*.kicad_mod" ), wxDIR_FILES ).IsEmpty() )
        {
            empty[name] = dir.GetPath();
        }
    }

    return empty;
}


bool COLLAB_PROJECT::DownloadAndExtract( const wxString& aServer, const wxString& aToken,
                                         const wxString& aProjectId,
                                         const wxString& aProjectName,
                                         const wxString& aTargetDir, wxString& aProFile,
                                         wxString& aError )
{
    aProFile.clear();

    std::optional<std::string> archive =
            COLLAB_REST::DownloadArchive( aServer, aToken, aProjectId );

    if( !archive )
    {
        aError = _( "Unable to download the shared project." );
        return false;
    }

    // A folder the system will not let us write to (a read-only location, or on macOS a
    // Documents / Desktop / Downloads folder the user has not allowed this app into) must
    // stop the download with one clear message.  Skipping the files that fail left a
    // half-empty folder and a string of "can't open file" errors from the project load.
    auto cannotWrite =
            [&]( const wxString& aPath )
            {
                aError = wxString::Format( _( "The project could not be saved to\n\n%s\n\n"
                                              "Junction is not allowed to write there." ),
                                           aPath );
#ifdef __WXMAC__
                aError += wxS( "\n\n" );
                aError += _( "If macOS asked whether Junction may access this folder, choose "
                             "Allow, or turn it on in System Settings > Privacy & Security > "
                             "Files and Folders > Junction, then open the project again." );
#else
                aError += wxS( "\n\n" );
                aError += _( "Check the folder's permissions, or use Open In Folder... to keep "
                             "the copy somewhere else." );
#endif
                // Leave no empty folder behind (a folder holding anything is kept as it is).
                if( wxFileName::DirExists( aTargetDir ) )
                    wxFileName::Rmdir( aTargetDir );

                return false;
            };

    // The failures below are reported through aError, not as a pile of log errors.
    wxLogNull noLog;

    if( !wxFileName::DirExists( aTargetDir )
        && !wxFileName::Mkdir( aTargetDir, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        return cannotWrite( aTargetDir );
    }

    if( !wxFileName::IsDirWritable( aTargetDir ) )
        return cannotWrite( aTargetDir );

    wxMemoryInputStream memStream( archive->data(), archive->size() );
    wxZipInputStream    zipStream( memStream );

    std::unique_ptr<wxZipEntry> entry;

    while( entry.reset( zipStream.GetNextEntry() ), entry )
    {
        if( entry->IsDir() )
            continue;

        // The server sanitizes uploads, but never trust archive paths anyway.
        wxString name = entry->GetName( wxPATH_UNIX );

        if( name.IsEmpty() || name.StartsWith( wxS( "/" ) ) || name.Contains( wxS( ".." ) )
            || name.Contains( wxS( ":" ) ) )
            continue;

        wxFileName target( aTargetDir + wxFileName::GetPathSeparator()
                           + wxFileName( name, wxPATH_UNIX ).GetFullPath() );

        if( !target.DirExists()
            && !wxFileName::Mkdir( target.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        {
            return cannotWrite( target.GetPath() );
        }

        // A join writes archive entries verbatim, so it is the one design-file write that cannot
        // honour the format version the local file was kept at.  Say so rather than letting a
        // preserved-version project silently acquire the uploader's newer stamp.
        const int previousVersion = KICAD_FORMAT::FileFormatVersionStamp( target.GetFullPath() );

        {
            wxFFileOutputStream out( target.GetFullPath() );

            if( !out.IsOk() )
                return cannotWrite( target.GetFullPath() );

            zipStream.Read( out );

            if( !out.IsOk() || !out.Close() )
                return cannotWrite( target.GetFullPath() );
        }

        if( previousVersion > 0 )
        {
            const int newVersion = KICAD_FORMAT::FileFormatVersionStamp( target.GetFullPath() );

            if( newVersion > previousVersion )
            {
                wxLogTrace( traceCollab,
                            wxS( "join raised '%s' file format version %d -> %d" ),
                            target.GetFullName(), previousVersion, newVersion );
            }
        }

        if( target.GetExt() == wxS( "kicad_pro" ) && aProFile.IsEmpty() )
            aProFile = target.GetFullPath();
    }

    // Pair the copy with the online project where the editors look for it:
    // beside the .kicad_pro, under that file's name (the online name can
    // differ, e.g. after a rename).  The download is the online state, so it
    // is also the base for the next merge.
    wxString linkDir = aTargetDir;
    wxString linkName = aProjectName;

    if( !aProFile.IsEmpty() )
    {
        wxFileName pro( aProFile );
        linkDir = pro.GetPath();
        linkName = pro.GetName();
    }

    WriteLocalLink( linkDir, linkName, aServer, aProjectId );
    SeedSyncBases( linkDir, linkName );
    EnsureLibraryFolders( linkDir );

    return true;
}
