/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright (C) 2014 Henner Zeller <h.zeller@acm.org>
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

#include "panel_symbol_chooser.h"

#include <class_draw_panel_gal.h>
#include <pgm_base.h>
#include <settings/common_settings.h>
#include <kiface_base.h>
#include <sch_base_frame.h>
#include <project_sch.h>
#include <libraries/symbol_library_adapter.h>
#include <widgets/lib_tree.h>
#include <widgets/symbol_preview_widget.h>
#include <widgets/footprint_preview_widget.h>
#include <widgets/footprint_select_widget.h>
#include <widgets/ui_common.h>
#include <settings/settings_manager.h>
#include <project/project_file.h>
#include <eeschema_settings.h>
#include <symbol_editor_settings.h>
#include <string_utils.h>
#include <symbol_library_common.h>         // For SYMBOL_LIBRARY_FILTER
#include <algorithm>
#include <wx/button.h>
#include <wx/clipbrd.h>
#include <wx/display.h>
#include <wx/panel.h>
#include <wx/sizer.h>
#include <wx/splitter.h>
#include <wx/timer.h>
#include <wx/wxhtml.h>
#include <wx/log.h>
#include <wx/choice.h>
#include <wx/stattext.h>
#include <lib_symbol.h>
#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <collab/sch_vendor_parts.h>
#include <confirm.h>
#include <wx/app.h>
#include <wx/listctrl.h>
#include <wx/utils.h>
#include <thread>


wxString PANEL_SYMBOL_CHOOSER::g_symbolSearchString;
wxString PANEL_SYMBOL_CHOOSER::g_powerSearchString;

PANEL_SYMBOL_CHOOSER::PANEL_SYMBOL_CHOOSER( SCH_BASE_FRAME* aFrame, wxWindow* aParent,
                                            const SYMBOL_LIBRARY_FILTER* aFilter,
                                            std::vector<PICKED_SYMBOL>&  aHistoryList,
                                            std::vector<PICKED_SYMBOL>&  aAlreadyPlaced,
                                            bool aAllowFieldEdits, bool aShowFootprints, bool& aCancelled,
                                            std::function<void()> aAcceptHandler,
                                            std::function<void()> aEscapeHandler ) :
        wxPanel( aParent, wxID_ANY, wxDefaultPosition, wxDefaultSize ),
        m_symbol_preview( nullptr ),
        m_hsplitter( nullptr ),
        m_vsplitter( nullptr ),
        m_fp_sel_ctrl( nullptr ),
        m_fp_preview( nullptr ),
        m_tree( nullptr ),
        m_details( nullptr ),
        m_frame( aFrame ),
        m_acceptHandler( std::move( aAcceptHandler ) ),
        m_escapeHandler( std::move( aEscapeHandler ) ),
        m_showPower( false ),
        m_allow_field_edits( aAllowFieldEdits ),
        m_show_footprints( aShowFootprints ),
        m_bodyStyleLabel( nullptr ),
        m_bodyStyleChoice( nullptr ),
        m_selectedBodyStyle( 1 )
{
    SYMBOL_LIBRARY_ADAPTER*   libmgr = PROJECT_SCH::SymbolLibAdapter( &m_frame->Prj() );
    COMMON_SETTINGS::SESSION& session = Pgm().GetCommonSettings()->m_Session;
    PROJECT_FILE&             project = m_frame->Prj().GetProjectFile();

    // Make sure settings are loaded before we start running multi-threaded symbol loaders
    GetAppSettings<EESCHEMA_SETTINGS>( "eeschema" );
    GetAppSettings<SYMBOL_EDITOR_SETTINGS>( "symbol_editor" );

    m_adapter = SYMBOL_TREE_MODEL_ADAPTER::Create( m_frame, libmgr );
    SYMBOL_TREE_MODEL_ADAPTER* adapter = static_cast<SYMBOL_TREE_MODEL_ADAPTER*>( m_adapter.get() );

    if( aFilter )
    {
        const wxArrayString& liblist = aFilter->GetAllowedLibList();

        for( const wxString& nickname : liblist )
        {
            if( libmgr->HasLibrary( nickname, true ) )
            {
                bool pinned = alg::contains( session.pinned_symbol_libs, nickname )
                                || alg::contains( project.m_PinnedSymbolLibs, nickname );

                std::optional<LIBRARY_TABLE_ROW*> row = libmgr->GetRow( nickname );

                if( row.has_value() && !row.value()->Hidden()  )
                    adapter->AddLibrary( nickname, pinned );
            }
        }

        adapter->AssignIntrinsicRanks();

        if( aFilter->GetFilterPowerSymbols() )
        {
            static std::function<bool( LIB_TREE_NODE& )> powerFilter =
                    []( LIB_TREE_NODE& aNode ) -> bool
                    {
                        return aNode.m_IsPower;
                    };

            adapter->SetFilter( &powerFilter );

            m_showPower = true;
            m_show_footprints = false;
        }
    }

    std::vector<LIB_SYMBOL>     history_list_storage;
    std::vector<LIB_TREE_ITEM*> history_list;
    std::vector<LIB_SYMBOL>     already_placed_storage;
    std::vector<LIB_TREE_ITEM*> already_placed;

    // Lambda to encapsulate the common logic
    auto processList =
            [&]( const std::vector<PICKED_SYMBOL>& inputList,
                 std::vector<LIB_SYMBOL>&          storageList,
                 std::vector<LIB_TREE_ITEM*>&      resultList )
            {
                storageList.reserve( inputList.size() );

                for( const PICKED_SYMBOL& i : inputList )
                {
                    LIB_SYMBOL* symbol = m_frame->GetLibSymbol( i.LibId );

                    if( symbol )
                    {
                        storageList.emplace_back( *symbol );

                        for( const auto& [fieldType, fieldValue] : i.Fields )
                        {
                            SCH_FIELD* field = storageList.back().GetField( fieldType );

                            if( field )
                                field->SetText( fieldValue );
                        }

                        resultList.push_back( &storageList.back() );
                    }
                }
            };

    // Sort the already placed list since it is potentially from multiple sessions,
    // but not the most recent list since we want this listed by most recent usage.
    std::sort( aAlreadyPlaced.begin(), aAlreadyPlaced.end(),
               []( PICKED_SYMBOL const& a, PICKED_SYMBOL const& b )
               {
                   return a.LibId.GetLibItemName() < b.LibId.GetLibItemName();
               } );

    processList( aHistoryList, history_list_storage, history_list );
    processList( aAlreadyPlaced, already_placed_storage, already_placed );

    adapter->DoAddLibrary( wxT( "-- " ) + _( "Recently Used" ) + wxT( " --" ), wxEmptyString, history_list,
                           false, true )
            .m_IsRecentlyUsedGroup = true;

    if( !aHistoryList.empty() )
        adapter->SetPreselectNode( aHistoryList[0].LibId, aHistoryList[0].Unit );

    adapter->DoAddLibrary( wxT( "-- " ) + _( "Already Placed" ) + wxT( " --" ), wxEmptyString, already_placed,
                           false, true )
            .m_IsAlreadyPlacedGroup = true;

    adapter->AddLibraries( m_frame );

    // -------------------------------------------------------------------------------------
    // Construct the actual panel
    //

    wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

    // Use a slightly different layout, with a details pane spanning the entire window,
    // if we're not showing footprints.
    if( m_show_footprints )
    {
        m_hsplitter = new wxSplitterWindow( this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                            wxSP_LIVE_UPDATE | wxSP_NOBORDER | wxSP_3DSASH );

        //Avoid the splitter window being assigned as the Parent to additional windows
        m_hsplitter->SetExtraStyle( wxWS_EX_TRANSIENT );

        sizer->Add( m_hsplitter, 1, wxEXPAND, 5 );
    }
    else
    {
        m_vsplitter = new wxSplitterWindow( this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                            wxSP_LIVE_UPDATE | wxSP_NOBORDER | wxSP_3DSASH );

        m_hsplitter = new wxSplitterWindow( m_vsplitter, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                            wxSP_LIVE_UPDATE | wxSP_NOBORDER | wxSP_3DSASH );

        // Avoid the splitter window being assigned as the parent to additional windows.
        m_vsplitter->SetExtraStyle( wxWS_EX_TRANSIENT );
        m_hsplitter->SetExtraStyle( wxWS_EX_TRANSIENT );

        wxPanel*    detailsPanel = new wxPanel( m_vsplitter );
        wxBoxSizer* detailsSizer = new wxBoxSizer( wxVERTICAL );
        detailsPanel->SetSizer( detailsSizer );

        m_details = new HTML_WINDOW( detailsPanel, wxID_ANY, wxDefaultPosition, wxDefaultSize  );
        detailsSizer->Add( m_details, 1, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 5 );
        detailsPanel->Layout();
        detailsSizer->Fit( detailsPanel );

        m_vsplitter->SetSashGravity( 0.5 );
        m_vsplitter->SetMinimumPaneSize( 20 );
        m_vsplitter->SplitHorizontally( m_hsplitter, detailsPanel );

        sizer->Add( m_vsplitter, 1, wxEXPAND | wxBOTTOM, 5 );
    }

    wxPanel*    treePanel = new wxPanel( m_hsplitter );
    wxBoxSizer* treeSizer = new wxBoxSizer( wxVERTICAL );
    treePanel->SetSizer( treeSizer );

    m_tree = new LIB_TREE( treePanel, m_showPower ? wxT( "power" ) : wxT( "symbols" ), m_adapter,
                           LIB_TREE::FLAGS::ALL_WIDGETS, m_details );

    treeSizer->Add( m_tree, 1, wxALL | wxEXPAND, 5 );

    // Power symbols are KiCad's own; vendors sell parts
    if( !m_showPower )
        buildVendorSection( treePanel, treeSizer );

    treePanel->Layout();
    treeSizer->Fit( treePanel );

    m_adapter->FinishTreeInitialization();

    if( m_showPower )
        m_tree->SetSearchString( g_powerSearchString );
    else
        m_tree->SetSearchString( g_symbolSearchString );

    m_hsplitter->SetSashGravity( 0.8 );
    m_hsplitter->SetMinimumPaneSize( 20 );
    m_hsplitter->SplitVertically( treePanel, constructRightPanel( m_hsplitter ) );

    m_dbl_click_timer = new wxTimer( this );
    m_open_libs_timer = new wxTimer( this );

    SetSizer( sizer );

    Layout();

    Bind( wxEVT_TIMER, &PANEL_SYMBOL_CHOOSER::onCloseTimer, this, m_dbl_click_timer->GetId() );
    Bind( wxEVT_TIMER, &PANEL_SYMBOL_CHOOSER::onOpenLibsTimer, this, m_open_libs_timer->GetId() );
    Bind( EVT_LIBITEM_SELECTED, &PANEL_SYMBOL_CHOOSER::onSymbolSelected, this );
    Bind( EVT_LIBITEM_CHOSEN, &PANEL_SYMBOL_CHOOSER::onSymbolChosen, this );
    aFrame->Bind( wxEVT_MENU_OPEN, &PANEL_SYMBOL_CHOOSER::onMenuOpen, this );
    aFrame->Bind( wxEVT_MENU_CLOSE, &PANEL_SYMBOL_CHOOSER::onMenuClose, this );

    if( m_fp_sel_ctrl )
        m_fp_sel_ctrl->Bind( EVT_FOOTPRINT_SELECTED, &PANEL_SYMBOL_CHOOSER::onFootprintSelected, this );

    if( m_bodyStyleChoice )
        m_bodyStyleChoice->Bind( wxEVT_CHOICE, &PANEL_SYMBOL_CHOOSER::onSelectBodyStyle, this );

    if( m_details )
        m_details->Bind( wxEVT_CHAR_HOOK, &PANEL_SYMBOL_CHOOSER::OnDetailsCharHook, this );

    if( m_vendorList )
        Bind( wxEVT_TEXT, &PANEL_SYMBOL_CHOOSER::onSearchText, this );

    // Open the user's previously opened libraries on timer expiration.
    // This is done on a timer because we need a gross hack to keep GTK from garbling the
    // display. Must be longer than the search debounce timer.
    m_open_libs_timer->StartOnce( 300 );
}


PANEL_SYMBOL_CHOOSER::~PANEL_SYMBOL_CHOOSER()
{
    m_frame->Unbind( wxEVT_MENU_OPEN, &PANEL_SYMBOL_CHOOSER::onMenuOpen, this );
    m_frame->Unbind( wxEVT_MENU_CLOSE, &PANEL_SYMBOL_CHOOSER::onMenuClose, this );
    Unbind( wxEVT_TIMER, &PANEL_SYMBOL_CHOOSER::onCloseTimer, this );
    Unbind( EVT_LIBITEM_SELECTED, &PANEL_SYMBOL_CHOOSER::onSymbolSelected, this );
    Unbind( EVT_LIBITEM_CHOSEN, &PANEL_SYMBOL_CHOOSER::onSymbolChosen, this );

    // Vendor searches still on their way must not reach this panel
    if( m_vendorAlive )
        m_vendorAlive->store( false );

    if( m_vendorTimer )
    {
        m_vendorTimer->Stop();
        delete m_vendorTimer;
        m_vendorTimer = nullptr;
    }

    // Stop the timer during destruction early to avoid potential race conditions (that do happen)
    m_dbl_click_timer->Stop();
    m_open_libs_timer->Stop();
    delete m_dbl_click_timer;
    delete m_open_libs_timer;

    if( m_showPower )
        g_powerSearchString = m_tree->GetSearchString();
    else
        g_symbolSearchString = m_tree->GetSearchString();

    if( m_fp_sel_ctrl )
        m_fp_sel_ctrl->Unbind( EVT_FOOTPRINT_SELECTED, &PANEL_SYMBOL_CHOOSER::onFootprintSelected, this );

    if( m_details )
        m_details->Unbind( wxEVT_CHAR_HOOK, &PANEL_SYMBOL_CHOOSER::OnDetailsCharHook, this );

    if( EESCHEMA_SETTINGS* cfg = dynamic_cast<EESCHEMA_SETTINGS*>( Kiface().KifaceSettings() ) )
    {
        // Save any changes to column widths, etc.
        m_adapter->SaveSettings();

        cfg->m_SymChooserPanel.width = GetParent()->ToDIP( GetParent()->GetSize().x );
        cfg->m_SymChooserPanel.height = GetParent()->ToDIP( GetParent()->GetSize().y );

        cfg->m_SymChooserPanel.sash_pos_h = m_hsplitter->GetSashPosition();

        if( m_vsplitter )
            cfg->m_SymChooserPanel.sash_pos_v = m_vsplitter->GetSashPosition();

        cfg->m_SymChooserPanel.sort_mode = m_tree->GetSortMode();
    }

    m_frame = nullptr;
}


void PANEL_SYMBOL_CHOOSER::onMenuOpen( wxMenuEvent& aEvent )
{
    m_tree->BlockPreview( true );
    aEvent.Skip();
}


void PANEL_SYMBOL_CHOOSER::onMenuClose( wxMenuEvent& aEvent )
{
    m_tree->BlockPreview( false );
    aEvent.Skip();
}


void PANEL_SYMBOL_CHOOSER::OnChar( wxKeyEvent& aEvent )
{
    if( aEvent.GetKeyCode() == WXK_ESCAPE )
    {
        wxObject* eventSource = aEvent.GetEventObject();

        // With the footprint list dropped down, Escape closes the list, not the chooser.
        // This runs ahead of DIALOG_SHIM's own hook, so the rule has to live here too;
        // ending the dialog under the open list tore it down with the list still up and
        // crashed the editor (macOS).
        if( KIUI::DismissComboPopups( wxGetTopLevelParent( this ), true ) )
            return;

        if( wxTextCtrl* textCtrl = dynamic_cast<wxTextCtrl*>( eventSource ) )
        {
            // First escape cancels search string value
            if( textCtrl->GetValue() == m_tree->GetSearchString() && !m_tree->GetSearchString().IsEmpty() )
            {
                m_tree->SetSearchString( wxEmptyString );
                Regenerate();
                GetFocusTarget()->SetFocus();
                return;
            }
        }

        m_escapeHandler();
    }
    else
    {
        aEvent.Skip();
    }
}


wxPanel* PANEL_SYMBOL_CHOOSER::constructRightPanel( wxWindow* aParent )
{
    EDA_DRAW_PANEL_GAL::GAL_TYPE backend = EDA_DRAW_PANEL_GAL::GAL_TYPE::GAL_TYPE_MODERN;

    if( m_frame->GetCanvas() )
        backend = m_frame->GetCanvas()->GetBackend();
    else if( COMMON_SETTINGS* cfg = Pgm().GetCommonSettings() )
        backend = EDA_DRAW_PANEL_GAL::ResolveStoredCanvasType( cfg->m_Graphics.canvas_type );

    wxPanel*    panel = new wxPanel( aParent );
    wxBoxSizer* sizer = new wxBoxSizer( wxVERTICAL );

    m_symbol_preview = new SYMBOL_PREVIEW_WIDGET( panel, &m_frame->Kiway(), true, backend );
    m_symbol_preview->SetLayoutDirection( wxLayout_LeftToRight );

    wxBoxSizer* bodyStyleSizer = new wxBoxSizer( wxHORIZONTAL );
    m_bodyStyleLabel = new wxStaticText( panel, wxID_ANY, _( "Body style:" ) );
    m_bodyStyleChoice = new wxChoice( panel, wxID_ANY );
    m_bodyStyleChoice->Enable( false );
    bodyStyleSizer->Add( m_bodyStyleLabel, 0, wxALIGN_CENTER_VERTICAL | wxLEFT | wxTOP | wxBOTTOM, 5 );
    bodyStyleSizer->Add( m_bodyStyleChoice, 1, wxEXPAND | wxALL, 5 );
    sizer->Add( bodyStyleSizer, 0, wxEXPAND | wxBOTTOM, 5 );

    if( m_show_footprints )
    {
        sizer->Add( m_symbol_preview, 11, wxEXPAND | wxALL, 5 );

        m_fp_sel_ctrl = new FOOTPRINT_SELECT_WIDGET( m_frame, panel );
        sizer->Add( m_fp_sel_ctrl, 0, wxEXPAND | wxLEFT | wxRIGHT, 5 );

        m_fp_preview = new FOOTPRINT_PREVIEW_WIDGET( panel, m_frame->Kiway() );
        m_fp_preview->SetUserUnits( m_frame->GetUserUnits() );

        if( m_fp_preview )
            sizer->Add( m_fp_preview, 10, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 5 );
    }
    else
    {
        sizer->Add( m_symbol_preview, 1, wxEXPAND | wxALL, 5 );
    }

    panel->SetSizer( sizer );
    panel->Layout();
    sizer->Fit( panel );

    return panel;
}


void PANEL_SYMBOL_CHOOSER::FinishSetup()
{
    if( EESCHEMA_SETTINGS* cfg = dynamic_cast<EESCHEMA_SETTINGS*>( Kiface().KifaceSettings() ) )
    {
        auto horizPixelsFromDU =
                [&]( int x ) -> int
                {
                    wxSize sz( x, 0 );
                    return GetParent()->ConvertDialogToPixels( sz ).x;
                };

        EESCHEMA_SETTINGS::PANEL_SYM_CHOOSER& panelCfg = cfg->m_SymChooserPanel;

        // The persisted size is stored in DIP so it is independent of the monitor it was saved
        // on. Restoring raw pixels would scale the window by the DPI ratio when reopened on a
        // different-scale display, producing a window that spills across monitors.
        int w = panelCfg.width > 40 ? GetParent()->FromDIP( panelCfg.width ) : horizPixelsFromDU( 440 );
        int h = panelCfg.height > 40 ? GetParent()->FromDIP( panelCfg.height ) : horizPixelsFromDU( 340 );

        // Cap to the work area so a stale pre-DIP setting cannot reopen the window across monitors.
        if( int display = wxDisplay::GetFromWindow( GetParent() ); display != wxNOT_FOUND )
        {
            wxRect workArea = wxDisplay( display ).GetClientArea();
            w = std::min( w, workArea.GetWidth() );
            h = std::min( h, workArea.GetHeight() );
        }

        GetParent()->SetSize( wxSize( w, h ) );
        GetParent()->Layout();

        // We specify the width of the right window (m_symbol_view_panel), because specify
        // the width of the left window does not work as expected when SetSashGravity() is called

        if( panelCfg.sash_pos_h < 0 )
            panelCfg.sash_pos_h = horizPixelsFromDU( 220 );

        if( panelCfg.sash_pos_v < 0 )
            panelCfg.sash_pos_v = horizPixelsFromDU( 230 );

        m_hsplitter->SetSashPosition( panelCfg.sash_pos_h );

        if( m_vsplitter )
            m_vsplitter->SetSashPosition( panelCfg.sash_pos_v );

        m_adapter->SetSortMode( (LIB_TREE_MODEL_ADAPTER::SORT_MODE) panelCfg.sort_mode );
    }

    if( m_fp_preview && m_fp_preview->IsInitialized() )
    {
        // This hides the GAL panel and shows the status label
        m_fp_preview->SetStatusText( wxEmptyString );
    }

    if( m_fp_sel_ctrl )
        m_fp_sel_ctrl->Load( m_frame->Kiway(), m_frame->Prj() );
}


void PANEL_SYMBOL_CHOOSER::OnDetailsCharHook( wxKeyEvent& aEvent )
{
    if( m_details
        && aEvent.GetKeyCode() == 'C'
        && aEvent.ControlDown()
        && !aEvent.AltDown()
        && !aEvent.ShiftDown()
        && !aEvent.MetaDown() )
    {
        wxString txt = m_details->SelectionToText();
        wxLogNull doNotLog; // disable logging of failed clipboard actions

        if( wxTheClipboard->Open() )
        {
            wxTheClipboard->SetData( new wxTextDataObject( txt ) );
            wxTheClipboard->Flush(); // Allow data to be available after closing KiCad
            wxTheClipboard->Close();
        }
    }
    else
    {
        aEvent.Skip();
    }
}


void PANEL_SYMBOL_CHOOSER::SetCompatibilityCallback( SYMBOL_COMPAT_FUNC aFunc )
{
    m_compatCallback = std::move( aFunc );

    if( SYMBOL_TREE_MODEL_ADAPTER* symAdapter = dynamic_cast<SYMBOL_TREE_MODEL_ADAPTER*>( m_adapter.get() ) )
        symAdapter->SetCompatibilityCallback( m_compatCallback );
}


void PANEL_SYMBOL_CHOOSER::SetPreselect( const LIB_ID& aPreselect )
{
    m_adapter->SetPreselectNode( aPreselect, 0 );

    if( m_tree && aPreselect.IsValid() )
        m_tree->SelectLibId( aPreselect );
}


LIB_ID PANEL_SYMBOL_CHOOSER::GetSelectedLibId( int* aUnit, int* aBodyStyle ) const
{
    if( m_vendorRow >= 0 )
    {
        // A vendor part, kept in the project's vendor library by AcceptVendorPart()
        if( aUnit )
            *aUnit = 0;

        if( aBodyStyle )
            *aBodyStyle = 1;

        return m_vendorLibId;
    }

    LIB_ID id = m_tree->GetSelectedLibId( aUnit );

    if( aBodyStyle )
        *aBodyStyle = m_selectedBodyStyle;

    return id;
}


void PANEL_SYMBOL_CHOOSER::updateBodyStyleChoice( LIB_SYMBOL* aSymbol )
{
    int bodyStyleCount = aSymbol ? std::max( aSymbol->GetBodyStyleCount(), 1 ) : 1;

    m_bodyStyleChoice->Enable( bodyStyleCount > 1 );
    m_bodyStyleChoice->Clear();

    if( bodyStyleCount > 1 )
    {
        for( int i = 1; i <= bodyStyleCount; i++ )
            m_bodyStyleChoice->Append( aSymbol->GetBodyStyleDescription( i, false ) );

        if( m_selectedBodyStyle > static_cast<int>( m_bodyStyleChoice->GetCount() ) )
            m_selectedBodyStyle = 1;

        m_bodyStyleChoice->SetSelection( m_selectedBodyStyle - 1 );
    }
    else
    {
        m_selectedBodyStyle = 1;
    }
}


void PANEL_SYMBOL_CHOOSER::onSelectBodyStyle( wxCommandEvent& aEvent )
{
    int selection = m_bodyStyleChoice->GetSelection();

    if( selection < 0 )
        return;

    m_selectedBodyStyle = selection + 1;

    if( m_vendorRow >= 0 )
    {
        if( m_vendorPreview )
            m_symbol_preview->DisplayPart( m_vendorPreview.get(), 1, m_selectedBodyStyle );

        return;
    }

    LIB_TREE_NODE* node = m_tree->GetCurrentTreeNode();

    if( node && node->m_LibId.IsValid() )
        m_symbol_preview->DisplaySymbol( node->m_LibId, node->m_Unit, m_selectedBodyStyle );
}


void PANEL_SYMBOL_CHOOSER::ShutdownCanvases()
{
    m_symbol_preview->GetCanvas()->SetEvtHandlerEnabled( false );
    m_symbol_preview->GetCanvas()->StopDrawing();

    if( m_fp_preview )
    {
        m_fp_preview->GetPreviewPanel()->GetCanvas()->SetEvtHandlerEnabled( false );
        m_fp_preview->GetPreviewPanel()->GetCanvas()->StopDrawing();
    }
}


void PANEL_SYMBOL_CHOOSER::onCloseTimer( wxTimerEvent& aEvent )
{
    // Hack because of eaten MouseUp event. See PANEL_SYMBOL_CHOOSER::onSymbolChosen
    // for the beginning of this spaghetti noodle.

    wxMouseState state = wxGetMouseState();

    if( state.LeftIsDown() )
    {
        // Mouse hasn't been raised yet, so fire the timer again. Otherwise the
        // purpose of this timer is defeated.
        m_dbl_click_timer->StartOnce( PANEL_SYMBOL_CHOOSER::DBLCLICK_DELAY );
    }
    else
    {
        m_acceptHandler();
    }
}


void PANEL_SYMBOL_CHOOSER::onOpenLibsTimer( wxTimerEvent& aEvent )
{
    if( EESCHEMA_SETTINGS* cfg = dynamic_cast<EESCHEMA_SETTINGS*>( Kiface().KifaceSettings() ) )
        m_adapter->OpenLibs( cfg->m_LibTree.open_libs );
}


void PANEL_SYMBOL_CHOOSER::showFootprintFor( LIB_ID const& aLibId )
{
    if( !m_fp_preview || !m_fp_preview->IsInitialized() )
        return;

    LIB_SYMBOL* symbol = nullptr;

    try
    {
        symbol = PROJECT_SCH::SymbolLibAdapter( &m_frame->Prj() )->LoadSymbol( aLibId );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogError( _( "Error loading symbol %s from library '%s'." ) + wxS( "\n%s" ),
                    aLibId.GetLibItemName().wx_str(),
                    aLibId.GetLibNickname().wx_str(),
                    ioe.What() );
    }

    if( !symbol )
        return;

    m_fp_override.Empty();
    showFootprint( symbol->GetFootprint() );
}


void PANEL_SYMBOL_CHOOSER::showFootprint( wxString const& aFootprint )
{
    if( !m_fp_preview || !m_fp_preview->IsInitialized() )
        return;

    if( aFootprint == wxEmptyString )
    {
        m_fp_preview->SetStatusText( _( "No footprint specified" ) );
    }
    else
    {
        LIB_ID lib_id;

        if( lib_id.Parse( aFootprint ) == -1 && lib_id.IsValid() )
        {
            m_fp_preview->ClearStatus();
            m_fp_preview->DisplayFootprint( lib_id );
        }
        else
        {
            m_fp_preview->SetStatusText( _( "Invalid footprint specified" ) );
        }
    }
}


void PANEL_SYMBOL_CHOOSER::populateFootprintSelector( LIB_ID const& aLibId )
{
    if( !m_fp_sel_ctrl )
        return;

    m_fp_sel_ctrl->ClearFilters();

    LIB_SYMBOL* symbol = nullptr;

    if( aLibId.IsValid() )
    {
        try
        {
            symbol = PROJECT_SCH::SymbolLibAdapter( &m_frame->Prj() )->LoadSymbol( aLibId );
        }
        catch( const IO_ERROR& ioe )
        {
            wxLogError( _( "Error loading symbol %s from library '%s'." ) + wxS( "\n%s" ),
                        aLibId.GetLibItemName().wx_str(),
                        aLibId.GetLibNickname().wx_str(),
                        ioe.What() );
        }
    }

    if( symbol != nullptr )
    {
        int      pinCount = symbol->GetGraphicalPins( 0 /* all units */, 1 /* single bodyStyle */ ).size();
        wxString fp_name = symbol->GetFootprint();

        if( !m_fp_override.IsEmpty() )
            fp_name = m_fp_override;

        // Explicitly associated footprints (issue #2282) are listed ahead of the glob matches in
        // written order and bypass the pin-count filter; a mapped EP/NC footprint legally has more
        // pads than the symbol has pins.
        for( const ASSOCIATED_FOOTPRINT& assoc : symbol->GetEffectiveAssociatedFootprints() )
            m_fp_sel_ctrl->AddAlwaysIncludedFootprint( assoc.m_FootprintLibId );

        m_fp_sel_ctrl->FilterByPinCount( pinCount );
        m_fp_sel_ctrl->FilterByFootprintFilters( symbol->GetFPFilters(), true );
        m_fp_sel_ctrl->SetDefaultFootprint( fp_name );
        m_fp_sel_ctrl->UpdateList();
        m_fp_sel_ctrl->Enable();
    }
    else
    {
        m_fp_sel_ctrl->UpdateList();
        m_fp_sel_ctrl->Disable();
    }
}


void PANEL_SYMBOL_CHOOSER::onFootprintSelected( wxCommandEvent& aEvent )
{
    m_fp_override = aEvent.GetString();

    std::erase_if( m_field_edits,
            []( std::pair<FIELD_T, wxString> const& i )
            {
                return i.first == FIELD_T::FOOTPRINT;
            } );

    m_field_edits.emplace_back( std::make_pair( FIELD_T::FOOTPRINT, m_fp_override ) );

    showFootprint( m_fp_override );
}


void PANEL_SYMBOL_CHOOSER::onSymbolSelected( wxCommandEvent& aEvent )
{
    LIB_TREE_NODE* node = m_tree->GetCurrentTreeNode();
    bool           sameSymbolDifferentUnit = false;

    // A library symbol picked after a vendor part takes over; the tree losing its selection
    // because a vendor part was picked leaves the vendor part's preview alone.
    if( node && node->m_LibId.IsValid() )
        clearVendorSelection();
    else if( m_vendorRow >= 0 )
        return;

    if( node && node->m_LibId.IsValid() )
    {
        if( node->m_LibId == m_curSymbolId )
            sameSymbolDifferentUnit = true;
        else
            m_field_edits.clear();

        m_curSymbolId = node->m_LibId;
        LIB_SYMBOL* symbol = m_frame->GetLibSymbol( m_curSymbolId );

        updateBodyStyleChoice( symbol );

        m_symbol_preview->DisplaySymbol( m_curSymbolId, node->m_Unit, m_selectedBodyStyle );

        if( !node->m_Footprint.IsEmpty() )
        {
            wxCommandEvent evt( EVT_FOOTPRINT_SELECTED );
            evt.SetString( node->m_Footprint);
            onFootprintSelected( evt );
        }
        else if( sameSymbolDifferentUnit && !m_fp_override.IsEmpty())
        {
            showFootprint( m_fp_override );
        }
        else
        {
            showFootprintFor( m_curSymbolId );
        }

        populateFootprintSelector( m_curSymbolId );

        if( m_compatCallback && m_details )
        {
            std::vector<VARIANT_COMPAT_RESULT> issues = m_compatCallback( m_curSymbolId );

            if( !issues.empty() )
            {
                wxString html = wxS( "<br><b>" ) + _( "Compatibility Warnings:" ) + wxS( "</b><ul>" );

                for( const VARIANT_COMPAT_RESULT& issue : issues )
                    html += wxS( "<li>" ) + EscapeHTML( issue.detail ) + wxS( "</li>" );

                html += wxS( "</ul>" );
                m_details->AppendToPage( html );
            }
        }
    }
    else
    {
        m_curSymbolId = LIB_ID();
        m_symbol_preview->SetStatusText( _( "No symbol selected" ) );

        if( m_fp_preview && m_fp_preview->IsInitialized() )
            m_fp_preview->SetStatusText( wxEmptyString );

        m_field_edits.clear();
        updateBodyStyleChoice( nullptr );
        populateFootprintSelector( m_curSymbolId );
    }
}


void PANEL_SYMBOL_CHOOSER::onSymbolChosen( wxCommandEvent& aEvent )
{
    if( m_tree->GetSelectedLibId().IsValid() )
    {
        // Got a selection. We can't just end the modal dialog here, because wx leaks some events
        // back to the parent window (in particular, the MouseUp following a double click).
        //
        // NOW, here's where it gets really fun. wxTreeListCtrl eats MouseUp.  This isn't really
        // feasible to bypass without a fully custom wxDataViewCtrl implementation, and even then
        // might not be fully possible (docs are vague). To get around this, we use a one-shot
        // timer to schedule the dialog close.
        //
        // See PANEL_SYMBOL_CHOOSER::onCloseTimer for the other end of this spaghetti noodle.
        m_dbl_click_timer->StartOnce( PANEL_SYMBOL_CHOOSER::DBLCLICK_DELAY );
    }
}


void PANEL_SYMBOL_CHOOSER::Regenerate()
{
    LIB_ID savedSelection = m_tree->GetSelectedLibId();
    m_tree->Regenerate( true );

    if( savedSelection.IsValid() )
        m_tree->CenterLibId( savedSelection );
}


// ---------------------------------------------------------------------------------- vendor parts


void PANEL_SYMBOL_CHOOSER::buildVendorSection( wxWindow* aParent, wxSizer* aSizer )
{
    m_vendorAlive = std::make_shared<std::atomic<bool>>( true );

    m_vendorHeader = new wxStaticText( aParent, wxID_ANY, _( "Vendor parts" ) );
    m_vendorHeader->SetToolTip( _( "LCSC, Mouser and DigiKey parts matching the search, through Junction.  "
                                   "A part you pick is kept in the project's vendor library with its "
                                   "footprint." ) );

    m_vendorList = new wxListView( aParent, wxID_ANY, wxDefaultPosition, aParent->FromDIP( wxSize( -1, 150 ) ),
                                   wxLC_REPORT | wxLC_SINGLE_SEL );
    m_vendorList->AppendColumn( _( "Part" ), wxLIST_FORMAT_LEFT, aParent->FromDIP( 110 ) );
    m_vendorList->AppendColumn( _( "Manufacturer Part" ), wxLIST_FORMAT_LEFT, aParent->FromDIP( 150 ) );
    m_vendorList->AppendColumn( _( "Description" ), wxLIST_FORMAT_LEFT, aParent->FromDIP( 260 ) );
    m_vendorList->AppendColumn( _( "Stock" ), wxLIST_FORMAT_RIGHT, aParent->FromDIP( 70 ) );

    aSizer->Add( m_vendorHeader, 0, wxLEFT | wxRIGHT | wxTOP, 5 );
    aSizer->Add( m_vendorList, 0, wxALL | wxEXPAND, 5 );

    m_vendorHeader->Hide();
    m_vendorList->Hide();

    m_vendorTimer = new wxTimer( this );
    Bind( wxEVT_TIMER, &PANEL_SYMBOL_CHOOSER::onVendorTimer, this, m_vendorTimer->GetId() );
    m_vendorList->Bind( wxEVT_LIST_ITEM_SELECTED, &PANEL_SYMBOL_CHOOSER::onVendorSelected, this );
    m_vendorList->Bind( wxEVT_LIST_ITEM_ACTIVATED, &PANEL_SYMBOL_CHOOSER::onVendorActivated, this );

    // The search box may already hold the last search
    m_vendorTimer->StartOnce( 400 );
}


void PANEL_SYMBOL_CHOOSER::onSearchText( wxCommandEvent& aEvent )
{
    aEvent.Skip();

    // Other text boxes (the footprint picker) land here too; the timer only searches again
    // when the library search text changed
    if( m_vendorTimer )
        m_vendorTimer->StartOnce( 500 );
}


void PANEL_SYMBOL_CHOOSER::showVendorStatus( const wxString& aText )
{
    m_vendorHeader->SetLabel( aText );
    m_vendorHeader->Show();
    m_vendorHeader->GetParent()->Layout();
}


void PANEL_SYMBOL_CHOOSER::onVendorTimer( wxTimerEvent& aEvent )
{
    wxString query = m_tree->GetSearchString();
    query.Trim().Trim( false );

    if( query == m_vendorQuery )
        return;

    m_vendorQuery = query;
    ++m_vendorGeneration;
    clearVendorSelection();
    m_vendorList->DeleteAllItems();
    m_vendorResults = nlohmann::json::array();

    if( query.length() < 2 )
    {
        m_vendorHeader->Hide();
        m_vendorList->Hide();
        m_vendorHeader->GetParent()->Layout();
        return;
    }

    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
    {
        m_vendorList->Hide();
        showVendorStatus( _( "Vendor parts: sign in to Junction (File > Add Collaborators...) to search "
                             "LCSC, Mouser and DigiKey" ) );
        return;
    }

    m_vendorList->Show();
    showVendorStatus( wxString::Format( _( "Vendor parts: searching LCSC, Mouser and DigiKey for \"%s\"..." ),
                                        query ) );

    std::shared_ptr<std::atomic<bool>> alive = m_vendorAlive;
    unsigned                           generation = m_vendorGeneration;

    std::thread(
            [this, alive, generation, server, token, query]()
            {
                COLLAB_REST::ERROR_INFO       error;
                std::optional<nlohmann::json> answer = COLLAB_REST::SearchParts( server, token, query, 25, &error );

                wxTheApp->CallAfter(
                        [this, alive, generation, answer, error]()
                        {
                            if( !alive->load() || generation != m_vendorGeneration )
                                return;

                            if( !answer )
                                showVendorStatus( wxString::Format( _( "Vendor parts: %s" ),
                                                                    COLLAB_REST::DescribeError( error ) ) );
                            else
                                showVendorResults( *answer );
                        } );
            } )
            .detach();
}


void PANEL_SYMBOL_CHOOSER::showVendorResults( const nlohmann::json& aAnswer )
{
    m_vendorResults = aAnswer.value( "results", nlohmann::json::array() );

    if( !m_vendorResults.is_array() )
        m_vendorResults = nlohmann::json::array();

    auto text = []( const nlohmann::json& aObj, const char* aKey ) -> wxString
    {
        auto it = aObj.find( aKey );
        return it != aObj.end() && it->is_string() ? wxString::FromUTF8( it->get<std::string>() ) : wxString();
    };

    m_vendorList->Freeze();
    m_vendorList->DeleteAllItems();

    long row = 0;

    for( const nlohmann::json& hit : m_vendorResults )
    {
        if( !hit.is_object() )
            continue;

        wxString mpn = text( hit, "mpn" );
        wxString maker = text( hit, "manufacturer" );

        if( !maker.IsEmpty() )
            mpn << wxS( " (" ) << maker << wxS( ")" );

        wxString stock;

        if( hit.contains( "stock" ) && hit["stock"].is_number_integer() )
            stock = wxString::Format( wxS( "%lld" ), hit["stock"].get<long long>() );

        long item = m_vendorList->InsertItem( row, SCH_VENDOR_PARTS::ResultTitle( hit ) );
        m_vendorList->SetItem( item, 1, mpn );
        m_vendorList->SetItem( item, 2, text( hit, "description" ) );
        m_vendorList->SetItem( item, 3, stock );
        m_vendorList->SetItemData( item, row );
        ++row;
    }

    m_vendorList->Thaw();

    wxString errors;

    if( nlohmann::json errs = aAnswer.value( "errors", nlohmann::json::array() ); errs.is_array() )
    {
        for( const nlohmann::json& e : errs )
        {
            if( e.is_object() && !text( e, "message" ).IsEmpty() )
                errors << wxS( "  " ) << text( e, "message" );
        }
    }

    if( row == 0 )
        showVendorStatus( wxString::Format( _( "Vendor parts: nothing found for \"%s\"." ), m_vendorQuery ) + errors );
    else
        showVendorStatus( wxString::Format( _( "Vendor parts (%ld): pick one to keep it in the project" ), row )
                          + errors );
}


std::string PANEL_SYMBOL_CHOOSER::vendorKey( int aRow ) const
{
    if( aRow < 0 || !m_vendorResults.is_array() || aRow >= (int) m_vendorResults.size() )
        return std::string();

    const nlohmann::json& hit = m_vendorResults[aRow];
    return hit.value( "vendor", std::string() ) + ":" + hit.value( "vendor_id", std::string() );
}


void PANEL_SYMBOL_CHOOSER::clearVendorSelection()
{
    if( m_vendorRow < 0 )
        return;

    if( m_vendorList && m_vendorRow < m_vendorList->GetItemCount() )
        m_vendorList->Select( m_vendorRow, false );

    m_vendorRow = -1;
    m_vendorLibId = LIB_ID();
    m_vendorAcceptWhenFetched = false;
}


void PANEL_SYMBOL_CHOOSER::onVendorSelected( wxListEvent& aEvent )
{
    int row = (int) aEvent.GetData();

    if( vendorKey( row ).empty() )
        return;

    m_vendorRow = row;
    m_vendorLibId = LIB_ID();
    m_vendorAcceptWhenFetched = false;
    m_curSymbolId = LIB_ID();
    m_field_edits.clear();
    m_tree->Unselect();

    if( m_vendorNickname.IsEmpty() )
        m_vendorNickname = SCH_VENDOR_PARTS::LibraryNickname( m_frame->Prj() );

    std::string key = vendorKey( row );

    if( auto it = m_vendorParts.find( key ); it != m_vendorParts.end() )
    {
        showVendorPart( it->second );
        return;
    }

    m_symbol_preview->SetStatusText( _( "Fetching the part's drawings..." ) );

    if( m_fp_preview && m_fp_preview->IsInitialized() )
        m_fp_preview->SetStatusText( wxEmptyString );

    const nlohmann::json& hit = m_vendorResults[row];
    wxString vendor = wxString::FromUTF8( hit.value( "vendor", std::string() ) );
    wxString id = wxString::FromUTF8( hit.value( "vendor_id", std::string() ) );
    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );
    wxString nickname = m_vendorNickname;

    std::shared_ptr<std::atomic<bool>> alive = m_vendorAlive;

    std::thread(
            [this, alive, key, vendor, id, server, token, nickname]()
            {
                COLLAB_REST::ERROR_INFO       error;
                std::optional<nlohmann::json> part = COLLAB_REST::GetPart( server, token, vendor, id, nickname, &error );

                wxTheApp->CallAfter(
                        [this, alive, key, part, error]()
                        {
                            if( !alive->load() )
                                return;

                            if( part )
                                m_vendorParts[key] = *part;

                            // Only the row still selected is shown
                            if( vendorKey( m_vendorRow ) != key )
                                return;

                            if( !part )
                            {
                                m_symbol_preview->SetStatusText( COLLAB_REST::DescribeError( error ) );
                                m_vendorAcceptWhenFetched = false;
                                return;
                            }

                            showVendorPart( *part );

                            if( m_vendorAcceptWhenFetched )
                            {
                                m_vendorAcceptWhenFetched = false;

                                if( AcceptVendorPart() )
                                    m_acceptHandler();
                            }
                        } );
            } )
            .detach();
}


void PANEL_SYMBOL_CHOOSER::showVendorPart( const nlohmann::json& aPart )
{
    wxString error;
    m_vendorPreview = SCH_VENDOR_PARTS::SymbolFromPart( aPart, m_vendorNickname, error );

    updateBodyStyleChoice( m_vendorPreview.get() );

    if( m_vendorPreview )
        m_symbol_preview->DisplayPart( m_vendorPreview.get(), 1, m_selectedBodyStyle );
    else
        m_symbol_preview->SetStatusText( error );

    if( m_fp_preview && m_fp_preview->IsInitialized() )
    {
        wxString fpid = m_vendorPreview ? m_vendorPreview->GetFootprintField().GetText() : wxString();

        // A vendor footprint is only in the project once the part is kept; a standard one
        // (passives) is in KiCad's libraries already.
        if( fpid.IsEmpty() )
            m_fp_preview->SetStatusText( _( "No footprint specified" ) );
        else if( fpid.StartsWith( m_vendorNickname + wxS( ":" ) ) )
            m_fp_preview->SetStatusText( wxString::Format( _( "Footprint %s comes with the part" ), fpid ) );
        else
            showFootprint( fpid );
    }

    if( m_fp_sel_ctrl )
    {
        // The part's own footprint; another one can be chosen after placing, as for any symbol
        m_fp_sel_ctrl->ClearFilters();
        m_fp_sel_ctrl->SetDefaultFootprint( m_vendorPreview ? m_vendorPreview->GetFootprintField().GetText()
                                                            : wxString() );
        m_fp_sel_ctrl->UpdateList();
        m_fp_sel_ctrl->Disable();
    }

    if( m_details && m_vendorRow >= 0 )
    {
        const nlohmann::json& hit = m_vendorResults[m_vendorRow];

        auto text = []( const nlohmann::json& aObj, const char* aKey ) -> wxString
        {
            auto it = aObj.find( aKey );
            return it != aObj.end() && it->is_string() ? wxString::FromUTF8( it->get<std::string>() ) : wxString();
        };

        wxString html;
        html << wxS( "<b>" ) << EscapeHTML( SCH_VENDOR_PARTS::ResultTitle( hit ) ) << wxS( "</b><br>" );
        html << EscapeHTML( text( aPart, "mpn" ) ) << wxS( " &nbsp; " ) << EscapeHTML( text( aPart, "manufacturer" ) )
             << wxS( "<br>" );
        html << EscapeHTML( text( aPart, "description" ) ) << wxS( "<br>" );

        if( !text( aPart, "package" ).IsEmpty() )
            html << _( "Package:" ) << wxS( " " ) << EscapeHTML( text( aPart, "package" ) ) << wxS( "<br>" );

        if( !text( aPart, "url" ).IsEmpty() )
        {
            html << wxS( "<a href=\"" ) << EscapeHTML( text( aPart, "url" ) ) << wxS( "\">" )
                 << _( "Vendor page" ) << wxS( "</a><br>" );
        }

        if( m_vendorPreview )
        {
            html << wxS( "<br>" )
                 << wxString::Format( _( "Kept in the project as %s when you place it." ),
                                      EscapeHTML( m_vendorPreview->GetLibId().Format().wx_str() ) );
        }

        m_details->SetPage( html );
    }
}


void PANEL_SYMBOL_CHOOSER::onVendorActivated( wxListEvent& aEvent )
{
    if( vendorKey( m_vendorRow ).empty() )
        return;

    // Still on its way: place it when it lands
    if( !m_vendorParts.count( vendorKey( m_vendorRow ) ) )
    {
        m_vendorAcceptWhenFetched = true;
        return;
    }

    if( AcceptVendorPart() )
        m_acceptHandler();
}


bool PANEL_SYMBOL_CHOOSER::AcceptVendorPart()
{
    if( m_vendorRow < 0 )
        return true;

    if( m_vendorLibId.IsValid() )
        return true;

    std::string key = vendorKey( m_vendorRow );

    if( key.empty() )
        return true;

    auto it = m_vendorParts.find( key );

    if( it == m_vendorParts.end() )
    {
        // OK before the drawings arrived: fetch them now
        wxBusyCursor            busy;
        const nlohmann::json&   hit = m_vendorResults[m_vendorRow];
        wxString                server = COLLAB_SESSION::ServerUrl();
        COLLAB_REST::ERROR_INFO error;

        std::optional<nlohmann::json> part =
                COLLAB_REST::GetPart( server, COLLAB_AUTH::StoredToken( server ),
                                      wxString::FromUTF8( hit.value( "vendor", std::string() ) ),
                                      wxString::FromUTF8( hit.value( "vendor_id", std::string() ) ),
                                      m_vendorNickname, &error );

        if( !part )
        {
            DisplayErrorMessage( this, _( "The vendor part could not be fetched." ),
                                 COLLAB_REST::DescribeError( error ) );
            return false;
        }

        it = m_vendorParts.emplace( key, *part ).first;
    }

    wxString error;
    LIB_ID   id;

    {
        wxBusyCursor busy;
        id = SCH_VENDOR_PARTS::Install( m_frame->Prj(), it->second, m_vendorNickname, error );
    }

    if( !id.IsValid() )
    {
        DisplayErrorMessage( this, _( "The vendor part could not be added to the project." ), error );
        return false;
    }

    m_vendorLibId = id;
    return true;
}
