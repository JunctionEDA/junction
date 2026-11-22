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

#include <collab/sch_vendor_parts.h>

#include <ki_exception.h>
#include <lib_symbol.h>
#include <libraries/library_manager.h>
#include <libraries/library_table.h>
#include <libraries/symbol_library_adapter.h>
#include <pgm_base.h>
#include <project.h>
#include <project_sch.h>
#include <sch_field.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>
#include <settings/common_settings.h>

#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/intl.h>
#include <wx/log.h>


namespace
{

const wxChar* const traceVendorParts = wxT( "COLLAB" );


wxString str( const nlohmann::json& aObject, const char* aKey )
{
    if( !aObject.is_object() )
        return wxEmptyString;

    auto it = aObject.find( aKey );

    if( it == aObject.end() || !it->is_string() )
        return wxEmptyString;

    return wxString::FromUTF8( it->get<std::string>() );
}


/// The folder beside the project that keeps libraries the collaboration features write.
wxString libraryDir()
{
    COMMON_SETTINGS* settings = Pgm().GetCommonSettings();
    wxString         dir = settings ? settings->m_Collab.local_library_dir : wxString();

    return dir.IsEmpty() ? wxString( wxS( "collab-libs" ) ) : dir;
}


/// How the project's tables name our libraries: relative to the project, so the project moves.
wxString tableUri( const wxString& aNickname, const wxString& aExtension )
{
    return wxS( "${KIPRJMOD}/" ) + libraryDir() + wxS( "/" ) + aNickname + aExtension;
}


wxFileName libraryPath( PROJECT& aProject, const wxString& aNickname, const wxString& aExtension )
{
    wxFileName fn( aProject.GetProjectPath(), aNickname + aExtension );
    fn.AppendDir( libraryDir() );
    return fn;
}


/// Some other library already answers to aNickname in this project (any scope).
bool nicknameTakenElsewhere( LIBRARY_TABLE_TYPE aType, const wxString& aNickname,
                             const wxString& aOurUri )
{
    std::optional<LIBRARY_MANAGER_ADAPTER*> adapter = Pgm().GetLibraryManager().Adapter( aType );

    if( !adapter )
        return false;

    std::optional<LIBRARY_TABLE_ROW*> row = ( *adapter )->GetRow( aNickname );

    return row && *row && ( *row )->URI() != aOurUri;
}


/// Make sure the project table has our row for aNickname; true when it does (or now does).
bool ensureProjectRow( LIBRARY_TABLE_TYPE aType, const wxString& aNickname, const wxString& aUri,
                       wxString& aError )
{
    LIBRARY_MANAGER&              manager = Pgm().GetLibraryManager();
    std::optional<LIBRARY_TABLE*> table = manager.Table( aType, LIBRARY_TABLE_SCOPE::PROJECT );

    if( !table || !*table )
    {
        aError = _( "The project's library table could not be opened." );
        return false;
    }

    if( ( *table )->HasRow( aNickname ) )
        return true;

    LIBRARY_TABLE_ROW& row = ( *table )->InsertRow();
    row.SetNickname( aNickname );
    row.SetURI( aUri );
    row.SetType( wxS( "KiCad" ) );
    row.SetOptions( wxString() );
    row.SetDescription( _( "Vendor parts (LCSC, Mouser, DigiKey) placed from Junction" ) );
    row.SetOk( true );

    if( !( *table )->Save() )
    {
        aError = _( "The project's library table could not be saved." );
        return false;
    }

    return true;
}


void setField( LIB_SYMBOL& aSymbol, const wxString& aName, const wxString& aValue )
{
    if( aName.IsEmpty() || aValue.IsEmpty() )
        return;

    SCH_FIELD* field = aSymbol.FindFieldCaseInsensitive( aName );

    if( !field )
    {
        field = new SCH_FIELD( &aSymbol, FIELD_T::USER, aName );
        field->SetVisible( false );
        aSymbol.AddField( field );
    }

    field->SetText( aValue );
}

} // namespace


wxString SCH_VENDOR_PARTS::LibraryNickname( PROJECT& aProject )
{
    const wxString preferred = wxS( "LCSC" );

    if( !nicknameTakenElsewhere( LIBRARY_TABLE_TYPE::SYMBOL, preferred, tableUri( preferred, wxS( ".kicad_sym" ) ) )
        && !nicknameTakenElsewhere( LIBRARY_TABLE_TYPE::FOOTPRINT, preferred, tableUri( preferred, wxS( ".pretty" ) ) ) )
    {
        return preferred;
    }

    return wxS( "Junction_LCSC" );
}


std::unique_ptr<LIB_SYMBOL> SCH_VENDOR_PARTS::SymbolFromPart( const nlohmann::json& aPart,
                                                              const wxString& aNickname, wxString& aError )
{
    const nlohmann::json cad = aPart.is_object() ? aPart.value( "cad", nlohmann::json() ) : nlohmann::json();
    const nlohmann::json sym = cad.is_object() ? cad.value( "symbol", nlohmann::json() ) : nlohmann::json();
    const nlohmann::json fp = cad.is_object() ? cad.value( "footprint", nlohmann::json() ) : nlohmann::json();

    std::string text = sym.is_object() ? sym.value( "sexpr", std::string() ) : std::string();

    if( text.empty() )
    {
        aError = _( "No vendor publishes a schematic symbol for this part." );
        return nullptr;
    }

    std::vector<LIB_SYMBOL*> parsed;

    try
    {
        parsed = SCH_IO_KICAD_SEXPR::ParseLibSymbols( text, "vendor part" );
    }
    catch( const IO_ERROR& ioe )
    {
        aError = wxString::Format( _( "The part's symbol could not be read: %s" ), ioe.What() );
    }

    if( parsed.empty() )
    {
        if( aError.IsEmpty() )
            aError = _( "The part's symbol could not be read." );

        return nullptr;
    }

    std::unique_ptr<LIB_SYMBOL> symbol( parsed.front() );

    for( size_t i = 1; i < parsed.size(); ++i )
        delete parsed[i];

    // A symbol the server drew for the part is named in our library; a KiCad standard one
    // (Device:R for a resistor) is kept under the part's own name, so its vendor fields stay
    // with it.
    wxString name = str( sym, "name" );
    wxString libId = str( sym, "lib_id" );

    if( !libId.StartsWith( aNickname + wxS( ":" ) ) || name.IsEmpty() )
    {
        name = str( aPart, "mpn" );

        if( name.IsEmpty() )
            name = str( aPart, "vendor_id" );
    }

    for( const wxChar* bad : { wxS( ":" ), wxS( "/" ), wxS( "\\" ), wxS( " " ), wxS( "\t" ) } )
        name.Replace( bad, wxS( "_" ) );

    if( name.IsEmpty() )
    {
        aError = _( "The part has no name to keep it under." );
        return nullptr;
    }

    symbol->SetName( name );
    symbol->SetLibId( LIB_ID( aNickname, name ) );

    wxString value = str( aPart, "value" );

    if( !value.IsEmpty() )
        symbol->GetValueField().SetText( value );

    wxString fpid = str( fp, "fpid" );

    if( !fpid.IsEmpty() )
        symbol->GetFootprintField().SetText( fpid );

    wxString datasheet = str( aPart, "datasheet" );

    if( !datasheet.IsEmpty()
        && ( symbol->GetDatasheetField().GetText().IsEmpty() || symbol->GetDatasheetField().GetText() == wxS( "~" ) ) )
    {
        symbol->GetDatasheetField().SetText( datasheet );
    }

    wxString description = str( aPart, "description" );

    if( !description.IsEmpty() && symbol->GetDescriptionField().GetText().IsEmpty() )
        symbol->GetDescriptionField().SetText( description );

    // LCSC / Mouser / DigiKey, MPN, Manufacturer: what the BOM and the web editor read
    if( nlohmann::json fields = aPart.value( "fields", nlohmann::json() ); fields.is_object() )
    {
        for( auto it = fields.begin(); it != fields.end(); ++it )
        {
            if( it.value().is_string() )
                setField( *symbol, wxString::FromUTF8( it.key() ),
                          wxString::FromUTF8( it.value().get<std::string>() ) );
        }
    }

    return symbol;
}


LIB_ID SCH_VENDOR_PARTS::Install( PROJECT& aProject, const nlohmann::json& aPart, const wxString& aNickname,
                                  wxString& aError )
{
    if( aProject.GetProjectPath().IsEmpty() )
    {
        aError = _( "Save the schematic as a project first: vendor parts are kept with the project." );
        return LIB_ID();
    }

    std::unique_ptr<LIB_SYMBOL> symbol = SymbolFromPart( aPart, aNickname, aError );

    if( !symbol )
        return LIB_ID();

    LIB_ID           id = symbol->GetLibId();
    LIBRARY_MANAGER& manager = Pgm().GetLibraryManager();

    // The footprint first, so the symbol never names one that is not there.
    const nlohmann::json cad = aPart.value( "cad", nlohmann::json() );
    const nlohmann::json fp = cad.is_object() ? cad.value( "footprint", nlohmann::json() ) : nlohmann::json();
    wxString             fpid = str( fp, "fpid" );
    std::string          fpText = fp.is_object() ? fp.value( "sexpr", std::string() ) : std::string();

    if( !fpText.empty() && fpid.StartsWith( aNickname + wxS( ":" ) ) )
    {
        wxFileName dir = libraryPath( aProject, aNickname, wxS( ".pretty" ) );
        wxString   fpName = fpid.AfterFirst( ':' );
        wxFileName file( dir.GetFullPath(), fpName, wxS( "kicad_mod" ) );

        if( !wxFileName::DirExists( dir.GetFullPath() )
            && !wxFileName::Mkdir( dir.GetFullPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
        {
            aError = wxString::Format( _( "Could not create '%s'." ), dir.GetFullPath() );
            return LIB_ID();
        }

        wxFFile out( file.GetFullPath(), wxS( "wb" ) );

        if( !out.IsOpened() || !out.Write( fpText.data(), fpText.size() ) )
        {
            aError = wxString::Format( _( "Could not write '%s'." ), file.GetFullPath() );
            return LIB_ID();
        }

        out.Close();

        if( !ensureProjectRow( LIBRARY_TABLE_TYPE::FOOTPRINT, aNickname, tableUri( aNickname, wxS( ".pretty" ) ),
                               aError ) )
        {
            return LIB_ID();
        }

        manager.ReloadLibraryEntry( LIBRARY_TABLE_TYPE::FOOTPRINT, aNickname, LIBRARY_TABLE_SCOPE::PROJECT );
    }

    wxFileName symFile = libraryPath( aProject, aNickname, wxS( ".kicad_sym" ) );

    if( !wxFileName::DirExists( symFile.GetPath() )
        && !wxFileName::Mkdir( symFile.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        aError = wxString::Format( _( "Could not create '%s'." ), symFile.GetPath() );
        return LIB_ID();
    }

    if( !ensureProjectRow( LIBRARY_TABLE_TYPE::SYMBOL, aNickname, tableUri( aNickname, wxS( ".kicad_sym" ) ),
                           aError ) )
    {
        return LIB_ID();
    }

    SYMBOL_LIBRARY_ADAPTER* adapter = PROJECT_SCH::SymbolLibAdapter( &aProject );

    if( !adapter )
    {
        aError = _( "The symbol libraries are not available." );
        return LIB_ID();
    }

    // The sexpr plugin refuses to save into a library file that does not exist yet
    if( !symFile.FileExists() && !adapter->CreateLibrary( aNickname ) )
    {
        aError = wxString::Format( _( "Could not create '%s'." ), symFile.GetFullPath() );
        return LIB_ID();
    }

    if( adapter->SaveSymbol( aNickname, std::move( symbol ), true ) != SYMBOL_LIBRARY_ADAPTER::SAVE_OK )
    {
        aError = wxString::Format( _( "Could not save the symbol in '%s'." ), symFile.GetFullPath() );
        return LIB_ID();
    }

    manager.ReloadLibraryEntry( LIBRARY_TABLE_TYPE::SYMBOL, aNickname, LIBRARY_TABLE_SCOPE::PROJECT );

    wxLogTrace( traceVendorParts, wxS( "vendor part %s kept as %s" ), str( aPart, "vendor_id" ),
                id.Format().wx_str() );

    return id;
}


wxString SCH_VENDOR_PARTS::ResultTitle( const nlohmann::json& aResult )
{
    wxString title = str( aResult, "vendor_name" );

    if( title.IsEmpty() )
    {
        wxString vendor = str( aResult, "vendor" );

        if( vendor == wxS( "lcsc" ) )
            title = wxS( "LCSC" );
        else if( vendor == wxS( "mouser" ) )
            title = wxS( "Mouser" );
        else if( vendor == wxS( "digikey" ) )
            title = wxS( "DigiKey" );
        else
            title = vendor;
    }

    title << wxS( " " ) << str( aResult, "vendor_id" );
    return title;
}
